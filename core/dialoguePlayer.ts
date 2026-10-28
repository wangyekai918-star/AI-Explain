/**
 * AI 讲解对话播放器（移植自 feature/large-screen DigitalEmployee/dialoguePlayer.js）
 * --------------------------------------------------------------------------
 * 核心机制（与大屏版一致）：
 *   - 逐句播放；语音合成"一次取一个"——每个合成请求只传单句
 *   - 按播放进度增量调度（_scheduleAhead）：首批仅首句（最快出声），此后每当
 *     剩余未播内容距预取水位线 ≤ AHEAD 句时安排下一批 —— 合成耗时与播放时间重叠
 *   - 结果按 lineId 填入缓存，播放循环按脚本顺序消费（_ensureAudio 命中缓存
 *     即时返回、未命中则等覆盖该句的在途请求），与返回先后无关 —— 保序
 *   - 合成结果带代次（generation）防御：load()/destroy() 换脚本后，旧脚本
 *     的在途请求返回时结果直接丢弃，不会污染新脚本缓存
 *   - pause() 停在当前句（句中被打断时回退一句），play() 从当前句重播
 *   - 句间停顿：角色切换 150ms / 同角色 80ms，保持对话呼吸感
 *   - 单句合成失败：跳句续播（讲解播报尽量播完），onError 上报由 UI 弱提示
 *   - 自动播放被浏览器拦截：pause + onAutoplayBlocked（UI 转 paused 态）
 *
 * 与大屏版的差异：**补回流式追加 appendLines**（大屏版脚本一次性返回，删过
 * 流式全套；本组件讲解稿经 SSE 流式到达）。播放循环每轮读 script.length，
 * 追加句自然被消费；run 收口（completed/failed）由控制器处理，无需 finish。
 *
 * ══════════════════ 虚拟时间轴（进度条 / seek / 倍速）══════════════════
 * 播报是"逐句独立 Audio"，没有一条承载全场的音频，所以连续进度条必须由
 * 播放器自己造一条**媒体时间轴**：
 *
 *   duration(i) = 真实 audio.duration（已合成且 metadata 到手） ?? 按字数估算
 *   startAt(i)  = Σ duration(0..i-1)
 *   duration    = startAt(n)      currentTime = startAt(pos.i) + pos.t
 *
 * 三条已定口径，改动前务必读懂：
 *  1. **全程媒体秒，倍速不进时长数学**。一句 10s 音频无论 playbackRate 是
 *     几，audio.duration 恒 10、currentTime 恒 0→10，2× 只是走完它需要的
 *     墙钟减半。进度条显示的就是媒体位置/媒体总长（与音乐播放器一致），
 *     所以 setRate 绝不重算时间轴 —— 若把 rate 掺进时长，变速瞬间整条轴
 *     缩放、播放头跳变。rate 唯一的外溢是句间停顿按 gap/rate 缩放。
 *  2. **句间停顿不计入时间轴**：它是无媒体的墙钟静默，计入要为非语音段
 *     另建映射，而 ≤150ms 在秒级刻度上不可辨。表现为停顿期播放头冻结在
 *     上一句尾、下句开播时跳到其头。
 *  3. **位置用 _pos = {i, t} 独立锚定，不复用循环游标 index**。pause() 有
 *     "句中打断则 index--"的语义（为的是续播重播本句），拿 index 反推位置
 *     会在暂停后少算一整句。_pos 只在 onLineStart / ticker / onLineEnd /
 *     seekTo 四处更新，与游标解耦。
 *
 * 校准不抖：真实时长到手只平移其**之后**各句的 startAt，而播放头只依赖
 * _pos.i **之前**各句的时长 —— 那些句子要么已真实播过（metadata 早已落地）、
 * 要么是合成失败被跳过的句（永久保持估算，不会再有校准事件），所以正向
 * 播放路径上播放头不受校准影响；只有总时长与后续句时间戳会随预取收敛。
 */

import { estimateLineSeconds, type AudioHandle, type TtsLine, type TtsMetaCallback, type TtsSynthesizer } from './ttsEngine'

/** 播放脚本的一行；appendLines 与 load 共用 */
export type ScriptLine = TtsLine

export type DialoguePlayerCallbacks = {
  /** 本句开播（音频就绪后才触发：文字与语音同步起步；合成失败的句子不触发） */
  onLineStart?: (line: ScriptLine, index: number) => void
  /** 本句音频播放完成（未被暂停打断），供 UI 兜底补全该句字幕 */
  onLineEnd?: (line: ScriptLine, index: number) => void
  onFinished?: () => void
  onError?: (error: Error, index: number) => void
  onAutoplayBlocked?: () => void
  /**
   * ~15Hz 进度上报（仅 playing 期间），暂停/结束/seek 时定点补发定格帧。
   * lineIndex/lineTime/lineDuration 一组给出"播放头在当前句内的百分比"；
   * version 在时长校准时递增，UI 据此重算各行时间戳。
   */
  onProgress?: (progress: PlayerProgress) => void
  /** seekTo 成功后回调，供 UI 复位字幕/打字机 */
  onSeek?: (index: number, lineTime: number) => void
}

export type PlayerProgress = {
  currentTime: number
  duration: number
  index: number
  lineIndex: number
  lineTime: number
  lineDuration: number
  version: number
}

export type DialoguePlayerOptions = DialoguePlayerCallbacks & {
  tts: TtsSynthesizer
  /** 首批起每批安排的句数（一句一请求；首批固定仅首句） */
  prefetch?: number
  gapSwitch?: number
  gapSame?: number
  /** 播报会话 ID，透传至合成请求 */
  sessionId?: string
}

export class DialoguePlayer {
  private readonly tts: TtsSynthesizer
  onLineStart?: (line: ScriptLine, index: number) => void
  onLineEnd?: (line: ScriptLine, index: number) => void
  onFinished?: () => void
  onError?: (error: Error, index: number) => void
  onAutoplayBlocked?: () => void
  onProgress?: (progress: PlayerProgress) => void
  onSeek?: (index: number, lineTime: number) => void
  /** 当前播报会话 ID，透传至 synthesizeBatch */
  sessionId: string | undefined
  private readonly prefetch: number
  private readonly gapSwitch: number
  private readonly gapSame: number

  script: ScriptLine[] = []
  private index = -1
  playing = false
  private readonly _audios = new Map<string, AudioHandle>()
  /** lineId → 覆盖该句的在途合成请求 Promise（多句并发在途，等待/去重按句粒度） */
  private readonly _inflight = new Map<string, Promise<void>>()
  /** 预取水位线：[0, _nextFetch) 已安排合成；播放推进到距水位线 ≤ AHEAD 句时安排下一批 */
  private _nextFetch = 0
  private _current: AudioHandle | null = null
  /** 脚本代次：load()/destroy() 递增。旧脚本的在途请求返回时按代次丢弃结果 */
  private _gen = 0
  /** 播放会话令牌：pause()/play() 递增使旧会话失效（防旧循环复活并发播放） */
  private _session = 0

  // ────────── 时间轴状态（见文件头三条口径） ──────────
  /** lineId → 真实媒体秒。与 _audios 缓存策略对称：同脚本保留、换脚本清空 */
  private readonly _durations = new Map<string, number>()
  /** startAt 前缀和缓存（长度 n+1，末位即总时长），_startsDirty 时重建 */
  private _starts: number[] = [0]
  private _startsDirty = true
  /** 播放位置锚：i = 所在句下标（-1 = 未开始），t = 句内媒体秒 */
  private _pos: { i: number, t: number } = { i: -1, t: 0 }
  private _rate = 1
  private _version = 0
  private _rafId: number | null = null
  private _rafSession = 0
  private _frames = 0

  constructor (options: DialoguePlayerOptions) {
    this.tts = options.tts
    this.onLineStart = options.onLineStart
    this.onLineEnd = options.onLineEnd
    this.onFinished = options.onFinished
    this.onError = options.onError
    this.onAutoplayBlocked = options.onAutoplayBlocked
    this.onProgress = options.onProgress
    this.onSeek = options.onSeek
    this.sessionId = options.sessionId
    this.prefetch = Math.max(1, options.prefetch ?? 4)
    this.gapSwitch = options.gapSwitch ?? 150
    this.gapSame = options.gapSame ?? 80

    /** ticker 回调（构造期绑定 this，便于 cancelAnimationFrame 传同一引用） */
    this._tick = () => {
      // 会话失效即自停：不依赖外部 cancel，避免旧会话误杀新会话的 ticker
      if (!this.playing || this._session !== this._rafSession) { this._rafId = null; return }
      this._rafId = requestAnimationFrame(this._tick)
      if (this._current) {
        this._pos.i = this.index
        this._pos.t = this._current.currentTime
      }
      // 60Hz 逐帧上报会带着整条字幕列表重渲染，按帧计数节流到 ~15Hz；
      // 进度条平滑交给 CSS transition，视觉无差别
      if (++this._frames % 4 !== 0) return
      this._emitProgress()
    }
  }

  private readonly _tick: () => void

  /**
   * 载入脚本（一次性成稿路径）：暂停并归位。同脚本（lineId 序列一致，如重播）
   * 保留已合成音频缓存 —— 已获取的音频不重复请求，句柄进度归零从头播；
   * 换新脚本才作废旧缓存与在途请求。流式成稿走 appendLines，不要用 load。
   */
  load (script: ScriptLine[], sessionId?: string) {
    this.pause()
    if (sessionId !== undefined) this.sessionId = sessionId
    if (this._sameScript(script)) {
      this._resetHandles()
    } else {
      this._gen++ // 作废旧脚本的在途请求（其返回后结果按代次丢弃）
      this._audios.clear()
      // 时长缓存与音频缓存同生命周期：换脚本 lineId 已无意义，留着会串台
      this._durations.clear()
      this._nextFetch = 0
    }
    this.script = script || []
    this.index = -1
    this._pos = { i: -1, t: 0 }
    this._startsDirty = true
    this._version++
    this._emitProgress()
  }

  /**
   * 流式追加（讲解稿生成期逐句/成段调用）：不重置进度与缓存；正在播放时
   * 循环自然消费新句，暂停时续播后消费。lineId 需保持唯一且有序。
   */
  appendLines (lines: ScriptLine[]) {
    if (!lines?.length) return
    this.script.push(...lines)
    this._startsDirty = true
    this._version++
    this._emitProgress()
  }

  /** 新旧脚本是否同内容（lineId 序列一致） */
  private _sameScript (newScript?: ScriptLine[]) {
    const b = newScript || []
    if (this.script.length !== b.length) return false
    return this.script.every((l, i) => l && b[i] && l.lineId === b[i].lineId)
  }

  /** 缓存句柄进度归零（保缓存从头播的路径共用：load 同脚本 / rewind） */
  private _resetHandles () {
    for (const h of this._audios.values()) {
      try { h.reset?.() } catch { /* 忽略 */ }
    }
  }

  /**
   * 播放（从当前进度继续）
   * @param fromIndex 指定起始句（内部按"游标前置一位"约定处理，循环首句 ++ 后正好落在该句）
   * @param startOffsetSec 起始句内的媒体秒偏移，**仅首句消费**（seekTo 续播、断点恢复走这条）
   */
  async play (fromIndex: number | null = null, startOffsetSec = 0) {
    if (this.playing) return
    if (fromIndex != null) this.index = fromIndex - 1
    if (this.index >= this.script.length - 1 && fromIndex == null) this.index = -1
    const session = ++this._session // 本次播放的会话令牌
    this.playing = true
    this._startTicker(session)

    while (this.playing && session === this._session) {
      if (this.index >= this.script.length - 1) break
      this.index++
      const line = this.script[this.index]
      let offset = this.index === fromIndex ? startOffsetSec : 0
      try {
        const audio = await this._ensureAudio(this.index)
        // 令牌失效 = 期间发生了 pause/load/replay（新会话已接管），安静退出
        if (!this.playing || session !== this._session) break
        if (!audio) {
          // 当前句合成失败（批次失败/后端漏返）：跳句续播，UI 弱提示计数
          this.onError?.(new Error('语音合成失败'), this.index)
          continue
        }
        // 真实时长已知则把偏移 clamp 进句内，避免越过句尾导致瞬间 onended 跳句
        const realDur = audio.duration
        if (offset > 0 && Number.isFinite(realDur) && realDur > 0) {
          offset = Math.min(offset, realDur)
        }
        audio.rate = this._rate // 新建/缓存句柄都要跟上当前倍速
        // 音频就绪后才输出文本（onLineStart）：首句需等单次合成请求返回，
        // 文字与语音同步起步；缓存命中的句子 ensureAudio 即时返回，不会引入
        // 额外延迟。合成失败的句子不触发 onLineStart（不显示）
        this.onLineStart?.(line, this.index)
        // 句内位置：显式偏移优先，否则取句柄当前进度 —— 暂停续播 / 暂停态
        // seek 后手动播放时 offset 为 0，但 handle.currentTime 停在断点上，
        // 不读它就会把播放头写回句首，出现"语音从断点出声、进度条从头走"失步
        this._pos = { i: this.index, t: offset || audio.currentTime || 0 }
        // 本句开播即按播放进度安排下一批合成（合成耗时与播放时间重叠）
        this._scheduleAhead(this.index)
        this._current = audio
        await audio.play(offset) // 等本句播完（stop() 会提前唤醒）
        // 新会话已接管：绝不触碰共享状态 —— 此处若无条件清 _current，会把新
        // 会话刚接管的句柄抹空，ticker 从此读不到音频位置、进度条卡在原地
        if (session !== this._session) return
        this._current = null
        if (!this.playing) break // 被暂停打断
        this._pos = { i: this.index, t: this._durOf(this.index) } // 定格在句尾
        this.onLineEnd?.(line, this.index)
        // 句间停顿：角色切换稍长，保持对话节奏。×1/rate 使倍速下听感节奏一致
        const next = this.script[this.index + 1]
        const gap = next && next.speaker !== line.speaker ? this.gapSwitch : this.gapSame
        await new Promise(r => setTimeout(r, gap / this._rate))
      } catch (e) {
        // 失效会话不触碰共享状态、不触发回调（新会话已接管播放）——
        // 清 _current 必须排在会话校验之后，否则会抹掉新会话的句柄
        if (session !== this._session) return
        this._current = null
        this._stopTicker()
        const error = e instanceof Error ? e : new Error(String(e))
        if (error.message === 'autoplay-blocked') {
          // 浏览器拦截自动播放：停下并交给 UI 引导手动播放。本句尚未真正
          // 出声，回退一句让续播从本句重来（否则 play 的 index++ 会跳过它）
          this.playing = false
          if (this.index >= 0) this.index--
          this.onAutoplayBlocked?.()
          return
        }
        if (this.playing) {
          // 播放被错误终止：先置状态再回调，让 UI 能感知"播放已停"并转暂停态
          this.playing = false
          this.onError?.(error, this.index)
          return
        }
        break
      }
    }

    // 仅当前会话有权收尾（避免旧会话误触发 onFinished / 关掉新会话的 ticker）
    if (session !== this._session) return
    this._stopTicker(true) // 补发定格帧：结束瞬间的进度必达
    const wasPlaying = this.playing
    this.playing = false
    this._current = null
    if (wasPlaying && this.index >= this.script.length - 1) {
      this.onFinished?.()
    }
  }

  /**
   * 暂停：停止当前句音频，并使所有活动播放会话失效（挂在句间停顿 /
   * 批次合成 await 上的旧循环醒来后因令牌不匹配安静退出，不会与新会话
   * 并发导致语音重复）。句中被打断时回退一句，续播时重播本句。
   */
  pause () {
    // 先把播放头同步到音频真实位置，再中断（_current 一旦置空就读不到了）
    if (this._current) {
      this._pos.i = this.index
      this._pos.t = this._current.currentTime
    }
    const midLine = !!this._current // _current 非空 = 当前句播到一半
    this._stopSession()
    if (midLine && this.index >= 0) this.index--
    this._stopTicker(true)
  }

  /**
   * 失效活动会话并停播当前句，**不动 index**。
   * 与 pause() 的分工是 seek 正确性的关键：pause() 的「句中打断 index--」
   * 专服务于"暂停→续播重播本句"（play 的 ++ 正好回到本句）；seek 是显式
   * 定位，借道 pause() 会让"seek 后不播"的状态永久错一位，且句间停顿时
   * _current 为空根本不回退 —— 两条路径不对称必埋雷。故 seek 走这里。
   */
  private _stopSession () {
    this._session++ // 失效活动会话
    this.playing = false
    const cur = this._current
    this._current = null
    try { cur?.stop() } catch { /* 忽略 */ }
  }

  /**
   * 进度归零（保留音频缓存）：关闭浮层/重播时调用，与 UI 侧文本复位
   * 保持原子一致 —— 重新打开从头播，语音与文本严格同步。缓存句柄进度
   * 一并归零；缓存保留使重开/重播首句秒开（后端亦有合成缓存）。
   */
  rewind () {
    this.pause()
    this.index = -1
    this._pos = { i: -1, t: 0 }
    this._startsDirty = true
    this._resetHandles()
    this._emitProgress()
  }

  /** 销毁：停止播放并断开脚本/缓存引用（组件卸载时调用） */
  destroy () {
    this.pause()
    this._stopTicker()
    this._gen++ // 在途请求返回后结果丢弃
    this.script = []
    this._audios.clear()
    this._inflight.clear()
    this._durations.clear()
    this.onProgress = undefined // 卸载后 ticker 若残留不得再回调
  }

  get currentIndex () {
    return this.index
  }

  // ══════════════════ 时间轴读数 ══════════════════

  /** 第 i 句时长（媒体秒）：真实校准值优先，未知则按字数估算 */
  private _durOf (i: number) {
    const line = this.script[i]
    if (!line) return 0
    const real = this._durations.get(line.lineId)
    return real && real > 0 ? real : estimateLineSeconds(line.text)
  }

  /** 重建 startAt 前缀和（O(n)，仅在时长变化后发生；n 为十几句，可忽略） */
  private _ensureStarts () {
    if (!this._startsDirty && this._starts.length === this.script.length + 1) return
    const arr = [0]
    for (let k = 0; k < this.script.length; k++) arr.push(arr[k] + this._durOf(k))
    this._starts = arr
    this._startsDirty = false
  }

  /** 第 i 句在时间轴上的起点（媒体秒），供 UI 派生每行时间戳 */
  startAt (i: number) {
    this._ensureStarts()
    return this._starts[i] ?? this._starts[this._starts.length - 1] ?? 0
  }

  /** 第 i 句时长（媒体秒），供 UI 派生时间戳与打字机按比例复位 */
  durationOf (i: number) {
    return this._durOf(i)
  }

  /** 全场总时长（媒体秒）。含未合成句的估算值，随预取推进逐步收敛 */
  get duration () {
    this._ensureStarts()
    return this._starts[this._starts.length - 1] || 0
  }

  /** 当前播放头（媒体秒）。_pos.i < 0 表示未开始/已归零 */
  get currentTime () {
    const i = this._pos.i
    if (i == null || i < 0) return 0
    const clamped = Math.max(0, Math.min(this._pos.t, this._durOf(i)))
    return this.startAt(i) + clamped
  }

  /** 全局媒体秒 → { i: 句下标, t: 句内偏移 }（n 只有十几句，顺序扫描即可） */
  private _locate (sec: number) {
    const n = this.script.length
    if (!n) return { i: 0, t: 0 }
    this._ensureStarts()
    let i = n - 1
    for (let k = 0; k < n; k++) {
      if (this._starts[k + 1] > sec) { i = k; break }
    }
    const d = this._durOf(i)
    let t = sec - this._starts[i]
    if (!(t >= 0)) t = 0
    // 留 50ms 余量，避免落在句尾导致零长即 onended 跳句
    if (d > 0 && t >= d) t = Math.max(0, d - 0.05)
    return { i, t }
  }

  /**
   * 真实时长到手（合成器 onMeta 回调）：写入校准表并标脏前缀和。
   * 只平移该句**之后**的 startAt，播放头所在句之前的读数不受影响。
   */
  private _calibrate (lineId: string, durSec: number) {
    if (!(durSec > 0) || this._durations.get(lineId) === durSec) return
    this._durations.set(lineId, durSec)
    this._startsDirty = true
    this._version++
    // 校准的正是当前定位句、且句内偏移已越过真实句尾 → clamp 回来
    if (this.script[this._pos.i]?.lineId === lineId && this._pos.t > durSec) {
      this._pos.t = durSec
    }
    if (this.playing) this._emitProgress()
  }

  // ══════════════════ 播放控制（倍速 / 定位）══════════════════

  get rate () {
    return this._rate
  }

  /**
   * 设倍速：只作用于当前句与后续句的 playbackRate，**不动时间轴数值**。
   * 时间轴是媒体时间，倍速改变的只是走完这些媒体秒的墙钟耗时 ——
   * 所以「10:50」这类读数在切倍速时保持不变（音乐播放器行为）。
   */
  setRate (r: number) {
    const rate = Number(r)
    if (!(rate > 0) || rate === this._rate) return
    this._rate = rate
    try { if (this._current) this._current.rate = rate } catch { /* 忽略 */ }
    this._emitProgress()
  }

  /**
   * 定位到全场某媒体秒（进度条点击/拖拽落点、±15 秒、断点恢复共用入口）。
   * @param opts.resume 默认取调用瞬间的 playing。打断续播必须显式传 true
   *   —— 断点保存时已 pause()，playing 早已是 false。
   */
  async seekTo (sec: number, { resume }: { resume?: boolean } = {}) {
    if (!this.script.length) return
    const wasPlaying = resume ?? this.playing
    this._stopTicker()
    this._stopSession()
    const target = Math.max(0, Math.min(Number(sec) || 0, Math.max(0, this.duration - 0.05)))
    const { i, t } = this._locate(target)
    // 已缓存句柄立刻落位，使"暂停态 seek → 之后手动 play"从该偏移出声；
    // 未合成句没有句柄，偏移随 play(k,t) 透传，由 _ensureAudio 建好后应用
    const h = this.script[i] ? this._audios.get(this.script[i].lineId) : undefined
    if (h) h.seek(t)
    this.index = i - 1 // 维持"游标前置一位"不变式，后续 play() 的 ++ 落在 i
    this._pos = { i, t }
    this.onSeek?.(i, t)
    this._emitProgress()
    if (wasPlaying) await this.play(i, t)
  }

  /** 相对当前播放头进退 delta 媒体秒（±15 秒按钮入口） */
  seekBy (deltaSec: number) {
    return this.seekTo(this.currentTime + (Number(deltaSec) || 0))
  }

  private _startTicker (session: number) {
    // 无条件先撤销在途回调再重开：若因 "已有 rafId" 提前返回，而那个在途
    // 回调属于失效会话，它会自行把 _rafId 清空 → 新会话一帧都收不到进度
    if (this._rafId != null) cancelAnimationFrame(this._rafId)
    this._rafSession = session
    this._frames = 0
    this._rafId = requestAnimationFrame(this._tick)
  }

  /** 停表；emitFinal=true 时补发一次定格进度（暂停/结束/seek 那一瞬不丢帧） */
  private _stopTicker (emitFinal = false) {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    if (emitFinal) this._emitProgress()
  }

  private _emitProgress () {
    const i = this._pos.i
    const dur = i < 0 ? 0 : this._durOf(i)
    this.onProgress?.({
      currentTime: this.currentTime,
      duration: this.duration,
      index: this.index,
      // 播放头所在句 + 句内进度。不能用循环游标 index：pause() 会把它 -1（为的是
      // 续播重播本句），UI 拿它做句内着色会整体错位一句。
      // lineTime 夹进 [0, dur]：当前句真实时长回写后可能小于原估算值，不夹会算出
      // >100% 的句内进度
      lineIndex: i,
      lineTime: i < 0 ? 0 : Math.max(0, Math.min(this._pos.t, dur)),
      lineDuration: dur,
      version: this._version,
    })
  }

  // ══════════════════ 增量合成调度 ══════════════════

  /**
   * 按播放进度增量安排合成（后台、不阻塞播放）：
   *   - 第一次只取第一句（1 个请求，最快出声；由 play 首句的 _ensureAudio
   *     兜底发起，此处把水位线推过首句）
   *   - 首句开播后取第二批 prefetch 句（一句一请求、并发）
   *   - 此后每当已播句距水位线 ≤ AHEAD 句（当前批即将播完）时安排下一批，
   *     合成耗时与播放时间重叠；已缓存/在途的句子跳过
   */
  private _scheduleAhead (i: number) {
    const AHEAD = 2 // 剩 ≤2 句播完即安排下一批
    while (i + AHEAD >= this._nextFetch && this._nextFetch < this.script.length) {
      // 首批仅首句：第一时间出声；第二批起恢复整批 prefetch 句
      const size = this._nextFetch === 0 ? 1 : this.prefetch
      const end = Math.min(this._nextFetch + size, this.script.length)
      for (let k = this._nextFetch; k < end; k++) {
        const l = this.script[k]
        if (this._audios.has(l.lineId) || this._inflight.has(l.lineId)) continue
        this._launchBatch(l).catch(() => { /* 失败句由 _ensureAudio 兜底 */ })
      }
      this._nextFetch = end
    }
  }

  /**
   * 确保当前句音频就绪（阻塞式）：命中缓存直接返回；该句有在途请求
   * （增量调度安排过、尚未返回）则等它落地；仍缺失才现场补拉这一句。
   * 按脚本顺序逐句调用，与各句返回先后无关 —— 并发下的保序点。
   * seek 到未合成句同样依赖这里（play 循环挂在本次 await 上）。
   */
  private async _ensureAudio (from: number): Promise<AudioHandle | null> {
    const line = this.script[from]
    if (!line) return null
    if (this._audios.has(line.lineId)) return this._audios.get(line.lineId)!

    // 该句在途：等它落地后命中缓存即返回（不重复发起）
    const pending = this._inflight.get(line.lineId)
    if (pending) {
      await pending.catch(() => { /* 失败句走兜底补拉 */ })
      if (this._audios.has(line.lineId)) return this._audios.get(line.lineId)!
    }

    // 兜底：该句无在途（如请求落地后失败/后端漏返）→ 现场补拉这一句
    await this._launchBatch(line).catch(() => { /* 返回 null 跳句 */ })
    const got = this._audios.get(line.lineId) || null
    if (!got) console.warn('[aeb-play] 句柄缺失，跳句续播', line.lineId)
    return got
  }

  /**
   * 发起一次合成（一次取一个：lines 只传单句），结果填入缓存；支持多句
   * 并发在途（_inflight 按句登记归属请求，供 _ensureAudio 等待与
   * _scheduleAhead 去重）。请求发起时快照代次，返回时脚本已更换
   * （gen 不匹配）则丢弃结果。
   */
  private _launchBatch (line: ScriptLine) {
    const gen = this._gen
    const p = this.tts.synthesizeBatch([line], {
      sessionId: this.sessionId,
      onMeta: (id, d) => this._calibrate(id, d),
    })
      .then((map) => {
        if (gen !== this._gen) return // 脚本已更换：丢弃过期请求的合成结果
        for (const [id, handle] of map) this._audios.set(id, handle)
      })
      .finally(() => {
        if (this._inflight.get(line.lineId) === p) this._inflight.delete(line.lineId)
      })
    this._inflight.set(line.lineId, p)
    // 请求失败：该句以 _audios 无记录体现，由 play 循环跳句处理
    return p
  }
}
