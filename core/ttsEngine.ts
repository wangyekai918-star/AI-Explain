/**
 * AI 讲解 TTS 引擎（移植自 feature/large-screen DigitalEmployee/ttsEngine.js）
 * ----------------------------------------------------------------------
 * 与大屏版的差异：
 *   - 合成 I/O 抽成 TtsSynthesizer 接口：后端批量合成 adapter 由宿主注入
 *     （大屏版直接 import batchTts；本组件的后端契约仍在设计中、地址可能不同）
 *   - 新增 BrowserSynthesizer（speechSynthesis）作为后端不可用时的降级
 *   - 静音句柄保留：无任何音频能力时的最终兜底（字幕链路照常可验）
 *
 * 句柄统一实现同一接口 { play(startFromSec), stop(), reset(), seek(sec),
 * get currentTime, get duration, set/get rate, url }。
 * 时间语义一律是**媒体秒**（与 HTMLAudio 的 currentTime/duration 同口径）：
 * 倍速只改变走完这些媒体秒所需的墙钟时间，不改变 duration 数值 ——
 * dialoguePlayer 的虚拟时间轴正是建立在这一点上。
 * estimateLineSeconds() 是"真实时长未知时的估算"唯一出口，静音句柄、
 * 浏览器句柄与时间轴共用同一条公式。
 */

/** A/B 角色元数据（名称与气泡侧别，UI 展示用；音色由后端按 speaker 映射） */
export const SPEAKER_META: Record<string, { name: string, side: 'left' | 'right' }> = {
  A: { name: '小电', side: 'left' },   // 女主播（文档角色设定）
  B: { name: '小特', side: 'right' },  // 男搭档
}

/** 中文估算语速：每字 0.22 秒（≈4.5 字/秒），最短 1.2 秒 */
const SEC_PER_CHAR = 0.22
const MIN_LINE_SEC = 1.2

/** 一句播报台词 */
export interface TtsLine {
  lineId: string
  /** 讲解角色（单人模式恒 'A'；双人模式 A/B 由讲解稿标记） */
  speaker: string
  text: string
  /** 语气提示（讲解稿 JSON 的 style，透传后端合成；浏览器/静音降级不感知） */
  style?: string
}

/** 音频句柄：播放器唯一感知的播放抽象 */
export interface AudioHandle {
  /** 播放本句直到播完/被打断；startFromSec>0 时从句内该媒体秒起播 */
  play (startFromSec?: number): Promise<void>
  stop (): void
  /** 进度归零（rewind/replay 从头语义） */
  reset (): void
  /** 句内定位（媒体秒），不改变播放/暂停态 */
  seek (sec: number): void
  readonly currentTime: number
  readonly duration: number
  rate: number
  readonly url: string | null
}

export type TtsMetaCallback = (lineId: string, durationSec: number) => void

export interface SynthesizeBatchOptions {
  retries?: number
  /** 真实音频时长到手回调（loadedmetadata / durationchange），供播放器校准时间轴 */
  onMeta?: TtsMetaCallback
  /** 播报会话 ID，透传至后端合成接口 */
  sessionId?: string
}

/** 语音合成器：把一批台词变成 lineId → 句柄 的映射 */
export interface TtsSynthesizer {
  synthesizeBatch (lines: TtsLine[], opts?: SynthesizeBatchOptions): Promise<Map<string, AudioHandle>>
}

/** 按文本长度估算该句媒体时长（秒）。静音/浏览器句柄与时间轴必须同源此公式。 */
export function estimateLineSeconds (text: string): number {
  return Math.max(MIN_LINE_SEC, (text || '').length * SEC_PER_CHAR)
}

/**
 * 后端批量合成 adapter：请求报文由 doBatch 决定（讲解服务现形态
 * filter={configId, data:[{speaker,text,style}]}，见 ce.vue 的 backendSynth）。
 * 出参按返回顺序与 lines 对位；条目即便带服务端自己的 lineId 也忽略
 * （请求未下发 lineId，服务端无从回传我方 ID，按外键入缓存播放器永远 miss）。
 * 端点/报文再变时只需调整 doBatch。
 */
export function createBatchSynthesizer (
  doBatch: (lines: TtsLine[], sessionId?: string) => Promise<Array<{ lineId?: string, audio: string }>>,
): TtsSynthesizer {
  return {
    async synthesizeBatch (lines, { retries = 1, onMeta, sessionId } = {}) {
      let lastErr: unknown = null
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await doBatch(lines, sessionId) || []
          const byLine = new Map((lines || []).map(l => [l.lineId, l]))
          const out = new Map<string, AudioHandle>()
          // 请求未下发 lineId，服务端不可能回传我方 ID：一律按返回顺序对位，
          // 条目里若有服务端自己的 lineId 必须忽略（否则按外键入缓存，播放器永远 miss）
          for (const [index, item] of res.entries()) {
            const line = lines[index]
            if (!line || !item) continue
            out.set(line.lineId, makeAudioHandle(item.audio || '', byLine.get(line.lineId), { onMeta }))
          }
          return out
        } catch (err) {
          lastErr = err
          console.warn('[aeb-tts] 批次失败', attempt + 1, '/', retries + 1, err instanceof Error ? err.message : err)
          if (attempt < retries) await new Promise(r => setTimeout(r, 500))
        }
      }
      throw lastErr || new Error('TTS 合成失败，已耗尽重试次数')
    },
  }
}

/** 后端不可用时的降级链终点：合成直接失败，由 CompositeSynthesizer 决定下一层 */
export class SynthesizeError extends Error {
  constructor (message = '语音合成失败') {
    super(message)
    this.name = 'SynthesizeError'
  }
}

/** 组合合成器：后端优先，批次失败（含合成结果整体缺失）时降级到 fallback */
export function createCompositeSynthesizer (primary: TtsSynthesizer, fallback: TtsSynthesizer): TtsSynthesizer {
  return {
    async synthesizeBatch (lines, opts) {
      try {
        const map = await primary.synthesizeBatch(lines, opts)
        // 全部句缺失视为失败（后端 mock 期返回空批），交由降级层
        if (map.size > 0 || !lines.length) return map
      } catch { /* 降级到 fallback */ }
      return fallback.synthesizeBatch(lines, opts)
    },
  }
}

/** speechSynthesis 能力检测 */
export function supportsSpeechSynthesis (): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
}

/**
 * 浏览器 speechSynthesis 合成（降级路径）。
 * 无法获得精确时长与句内 seek：进度用 estimateLineSeconds 的计时器推进
 * （与静音句柄同源），语音实际播完则提前 resolve；seek 只重置计时，
 * 语音从头念（降级模式下的可接受近似）。
 */
export function createBrowserSynthesizer (): TtsSynthesizer {
  return {
    synthesizeBatch (lines) {
      if (!supportsSpeechSynthesis()) return Promise.reject(new SynthesizeError('浏览器不支持语音合成'))
      const out = new Map<string, AudioHandle>()
      for (const line of lines) out.set(line.lineId, makeBrowserHandle(line.text))
      return Promise.resolve(out)
    },
  }
}

/** 浏览器默认音多为英文（中文文本会被跳读）：显式选中文音色；无 zh 音色时回 null 交给 lang 兜底 */
function pickChineseVoice (): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices() || []
    return voices.find(v => /^zh([-_])?cn/i.test(v.lang)) || voices.find(v => /^zh([-_]|$)/i.test(v.lang)) || null
  } catch { return null }
}

function makeBrowserHandle (text: string): AudioHandle {
  const duration = estimateLineSeconds(text)
  let elapsed = 0
  let rate = 1
  let timer: ReturnType<typeof setInterval> | null = null
  let last = 0
  let release: (() => void) | null = null
  let speaking = false

  const halt = () => { if (timer) { clearInterval(timer); timer = null } }
  const cancelSpeech = () => {
    if (!speaking) return
    speaking = false
    try { window.speechSynthesis.cancel() } catch { /* 已取消 */ }
  }

  return {
    play (startFromSec = 0) {
      return new Promise<void>((resolve) => {
        release = resolve
        if (startFromSec > 0) elapsed = Math.min(startFromSec, duration)
        last = performance.now()
        // 同一时刻浏览器只允许一条 utterance；上一句若还占着就先取消
        cancelSpeech()
        speaking = true
        try {
          const utterance = new SpeechSynthesisUtterance(text)
          utterance.lang = 'zh-CN'
          const voice = pickChineseVoice()
          if (voice) utterance.voice = voice
          utterance.rate = Math.max(0.5, Math.min(4, rate))
          utterance.onend = () => {
            if (!speaking) return
            speaking = false
            halt()
            elapsed = duration
            const r = release; release = null
            r?.()
          }
          utterance.onerror = (e) => { console.warn('[aeb-tts] 浏览器合成异常', (e as unknown as { error?: string })?.error) }
          window.speechSynthesis.speak(utterance)
        } catch { /* 合成失败：静默计时兜底，字幕链路不断 */ }
        timer = setInterval(() => {
          const now = performance.now()
          elapsed += ((now - last) / 1000) * rate
          last = now
          if (elapsed >= duration) {
            elapsed = duration
            halt()
            cancelSpeech()
            const r = release; release = null
            r?.()
          }
        }, 60)
      })
    },
    stop () {
      halt()
      cancelSpeech()
      const r = release; release = null
      r?.()
    },
    reset () {
      elapsed = 0
      this.stop()
    },
    seek (sec) {
      elapsed = Math.max(0, Math.min(sec, duration))
    },
    get currentTime () { return elapsed },
    get duration () { return duration },
    set rate (r) { rate = r },
    get rate () { return rate },
    url: null,
  }
}

/**
 * 造一个后端音频句柄：base64 → data URL → Audio。
 * audio 为空串走静音兜底（mock 期/单句失败不中断整场）。
 */
export function makeAudioHandle (audioBase64: string, line?: { lineId?: string, text?: string }, opts: { onMeta?: TtsMetaCallback } = {}): AudioHandle {
  if (!audioBase64) return makeSilenceHandle(line?.text || '')

  const url = audioBase64.startsWith('data:')
    ? audioBase64
    // 前缀嗅探：RIFF/WAV 以 audio/wav 下发，其余按 mp3（联调期两种格式都出现过）
    : `data:${audioBase64.startsWith('UklGR') ? 'audio/wav' : 'audio/mpeg'};base64,${audioBase64}`
  const audio = new Audio(url)
  audio.preload = 'auto'
  let release: (() => void) | null = null // stop() 时唤醒悬挂中的 play()，避免播放循环协程卡死
  let rate = 1
  // metadata 未到手时 seek 会静默失败（浏览器丢弃赋值），先记下来等事件
  let pendingSeek: number | null = null

  const realDuration = () =>
    (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0)

  const flushPendingSeek = () => {
    if (pendingSeek == null) return
    const d = realDuration()
    const target = d > 0 ? Math.min(pendingSeek, d) : pendingSeek
    pendingSeek = null
    try { audio.currentTime = target } catch { /* 未就绪，等下一次 */ }
  }

  // data URL 全内存，metadata 解析几乎即时（首句在 onLineStart 前必完成）；
  // 仍要事件驱动 —— 真实时长到手前时间轴只能用估算值
  const onMetaReady = () => {
    const d = realDuration()
    if (d) opts.onMeta?.(line?.lineId || '', d)
    flushPendingSeek()
  }
  audio.addEventListener('loadedmetadata', onMetaReady)
  audio.addEventListener('durationchange', onMetaReady)

  return {
    play (startFromSec = 0) {
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = () => { if (!settled) { settled = true; release = null; resolve() } }
        audio.onended = settle
        // 加载/解码失败按"播完"处理：上层跳句续播，不让单句坏数据中断整场。
        // 但必须显性告警——静默跳句会让"无声 bug"无法联调定位
        audio.onerror = () => {
          if (audio.error) console.warn('[aeb] 音频加载/解码失败，跳句续播', line?.lineId, `code=${audio.error.code}`, audio.error.message)
          settle()
        }
        release = settle
        // 已播完的句柄重播（缓存命中场景）：currentTime 停在结尾，直接 play 会瞬间
        // onended 跳句 —— 归零从头播。暂停续播场景 ended=false，从暂停点继续
        if (audio.ended) {
          try { audio.currentTime = 0 } catch { /* 忽略 */ }
        }
        if (startFromSec > 0) {
          try { audio.currentTime = startFromSec } catch { pendingSeek = startFromSec }
        }
        flushPendingSeek()
        try { audio.playbackRate = rate } catch { /* 忽略 */ }
        const p = audio.play()
        if (p && p.catch) {
          p.catch(() => {
            // 自动播放被浏览器拦截：区别于播完向上抛，由 UI 转 paused 态引导手动播放
            if (!settled && audio.paused) {
              settled = true
              release = null
              reject(new Error('autoplay-blocked'))
            }
          })
        }
      })
    },
    stop () {
      try { audio.pause() } catch { /* 忽略 */ }
      const r = release; release = null
      r?.()
    },
    /** 进度归零（rewind/replay 从头语义）：停播并把 currentTime 拉回起点。
     *  句柄保缓存复用时必须归零，否则句中中断后续播会从断点出声、
     *  而字幕已从头显示，造成语音与文本失步 */
    reset () {
      pendingSeek = null
      try { audio.pause() } catch { /* 忽略 */ }
      try { audio.currentTime = 0 } catch { /* 忽略 */ }
    },
    /** 句内定位（媒体秒），不改变播放/暂停态；clamp 到已知时长内 */
    seek (sec) {
      const d = realDuration()
      const target = Math.max(0, d > 0 ? Math.min(sec, d) : sec)
      pendingSeek = null
      try { audio.currentTime = target } catch { pendingSeek = target }
    },
    get currentTime () {
      const t = Number(audio.currentTime)
      return Number.isFinite(t) ? t : 0
    },
    /** 真实媒体秒；metadata 未到手返回 0（= 未知，调用方走估算） */
    get duration () {
      return realDuration()
    },
    set rate (r) {
      rate = r
      try { audio.playbackRate = r } catch { /* 忽略 */ }
    },
    get rate () { return rate },
    url,
  }
}

/**
 * 静音句柄（最终兜底）：无真实音频，用 interval 累加**媒体秒**模拟进度，
 * 与 Audio 句柄同接口 —— 时间轴、seek、倍速、断点续播在无音频下全部可用。
 * elapsed ×rate 推进：2× 时同样 10 媒体秒的句子 5 墙钟秒走完，与真音频一致。
 */
export function makeSilenceHandle (text: string): AudioHandle {
  const duration = estimateLineSeconds(text)
  let elapsed = 0
  let rate = 1
  let timer: ReturnType<typeof setInterval> | null = null
  let last = 0
  let release: (() => void) | null = null

  const halt = () => { if (timer) { clearInterval(timer); timer = null } }
  /** 停表并唤醒 play 协程（原 stop 语义），elapsed 保留 = 断点 */
  const stopWake = () => {
    halt()
    const r = release
    release = null
    r?.()
  }

  return {
    play (startFromSec = 0) {
      return new Promise<void>((resolve) => {
        if (startFromSec > 0) elapsed = Math.min(startFromSec, duration)
        release = resolve
        last = performance.now()
        timer = setInterval(() => {
          const now = performance.now()
          elapsed += ((now - last) / 1000) * rate
          last = now
          if (elapsed >= duration) {
            elapsed = duration
            halt()
            release = null
            resolve()
          }
        }, 60)
      })
    },
    stop () { stopWake() },
    reset () {
      elapsed = 0
      stopWake()
    },
    seek (sec) {
      elapsed = Math.max(0, Math.min(sec, duration))
    },
    get currentTime () { return elapsed },
    get duration () { return duration },
    set rate (r) { rate = r },
    get rate () { return rate },
    url: null,
  }
}
