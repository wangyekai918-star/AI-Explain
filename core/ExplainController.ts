import type { ExplainAssembleResult, ExplainServiceErrorCode, RobotConfig, TeldHubTaskEvent } from '../types'
import { ExplainServiceClient, ExplainServiceError } from './explainServiceClient'
import { DialoguePlayer, type ScriptLine } from './dialoguePlayer'
import { ScriptAssembler, extractScriptDoc } from './scriptAssembler'
import { startRecording, supportsRecording, type RecordController } from './recorder'
import type { RestTeldHubSessionRepository } from './rest/RestTeldHubSessionRepository'
import type { AudioHandle, TtsSynthesizer } from './ttsEngine'

/** 讲解阶段（UI 文案映射见需求文档第七章缩起态） */
export type ExplainPhase =
  | 'idle'          // 未发起
  | 'assembling'    // 组装讲解中（queryRobotConfig/assembleExplain）
  | 'generating'    // 正在分析内容（SSE 流式收稿，UI 必须有反馈）
  | 'interpreting'  // 解读中（成稿完成，合成首批音频）
  | 'playing'       // 播报中
  | 'paused'        // 已暂停·点击继续
  | 'answering'     // 追问中（answerStatus 区分分析/播报）
  | 'ended'         // 已结束
  | 'error'

export type ExplainErrorKind =
  | 'empty' | 'config-missing' | 'assemble-failed' | 'generate-failed'
  | 'tts-failed' | 'asr-failed' | 'permission-denied' | null

/** 追问对话分组:每次打断追问(文本/语音)成组保留,UI 按组展示/折叠/组级重播 */
export type ExplainDialogGroup = {
  id: string
  question: string
  /** 问题来源(语音/文本),UI 展示区分 */
  source: 'voice' | 'text'
  /** 回答原始行(与 answerLines 同引用;durable 定稿更新) */
  lines: ScriptLine[]
  /** 回答是否 JSON 讲解稿形态(重播时按同规则解析播报角色) */
  fromDoc: boolean
  /** 回答收口完成,可组级重播 */
  done: boolean
  /** 本次打断的主轨断点(媒体秒),进度条打断点标记用 */
  breakpoint: number
}

export type ExplainStateSnapshot = {
  phase: ExplainPhase
  updating?: boolean
  updateFailed?: boolean
  sourceLabel?: string
  contextHistory?: ExplainContextHistory[]
  /** 追问回答子状态（phase=answering 时有意义） */
  answerStatus: 'none' | 'analyzing' | 'playing' | 'paused'
  voiceState: 'idle' | 'recording' | 'recognizing'
  questionText: string
  answerText: string
  /** 追问回答行（对话流展示 + 逐行播报高亮；JSON 讲解稿行自带角色，纯文本回答为切句行） */
  answerLines: ScriptLine[]
  /** 回答播报进行中的行下标（-1 = 未在播报回答行） */
  answerLineIndex: number
  /** 连续回答的累计媒体时间；总时长就绪后才允许拖动。 */
  answerPlayback?: { groupId: string; currentTime: number; duration: number; ready: boolean } | null
  /** 多次追问的对话分组(历史保留;questionText/answerLines 等为活动组投影,向后兼容) */
  dialogGroups: ExplainDialogGroup[]
  /** 当前播报/分析中的组 id(无活动组为 null) */
  activeGroupId: string | null
  /** 主轨字幕行（追加语义；UI 按引用变化重渲染） */
  lines: ScriptLine[]
  /** 每行在时间轴上的起点（媒体秒），供字幕时间戳展示；随时长校准重算 */
  lineStarts: number[]
  currentLineIndex: number
  currentTime: number
  duration: number
  robotConfig: RobotConfig | null
  /** 打断开关：显式 askEnabled 优先，否则取 robotConfig.isInterrupt（默认开） */
  isInterruptEnabled: boolean
  error: { kind: ExplainErrorKind, message: string } | null
}

export type ExplainControllerOptions = {
  explainService: ExplainServiceClient
  /** WorkHub 会话仓（/runs 发送 + SSE 订阅） */
  repository: RestTeldHubSessionRepository
  /** 语音合成器（建议组合形态：后端→浏览器→静音） */
  synthesizer: TtsSynthesizer
  /** 对接配置 ID（讲解场景） */
  configId: string
  /** MD 内容来源：mdContext 直传（data_access_type=5）或 mdSearchParam（=1）；可返回 Promise（start 发起时才异步取数） */
  mdSource?: () => { mdContext?: string, mdSearchParam?: string } | Promise<{ mdContext?: string, mdSearchParam?: string }>
  /** 双人讲解模式（解析讲解稿角色标记） */
  duetMode?: boolean
  /** 显式打断开关；未设置时取 robotConfig.isInterrupt（默认允许） */
  askEnabled?: boolean
}

export type DataSourceUpdate = {
  label: string
  /** 在切换时立即调用 refresh；Promise 完成后才开始生成。 */
  mdSource: NonNullable<ExplainControllerOptions['mdSource']>
}
export type ExplainContextHistory = { label: string, lines: ScriptLine[], groups: ExplainDialogGroup[] }

export type ExplainController = {
  refresh (update: DataSourceUpdate): Promise<void>
  retryRefresh (): Promise<void>
  /** 发起讲解：组装 → 订阅 → 发送首轮流 → 流式成稿 → 自动开播 */
  start (): Promise<void>
  /** 预加载机器人配置（形象/主题/打断开关）；失败不阻塞，用默认外观 */
  loadRobotConfig (): Promise<void>
  /** 播放：主轨续播 / 回答播报暂停中则句内续播（组头 ▶ 继续共用） */
  play (): Promise<void>
  /** 暂停：主轨暂停 / 回答播报中则句内暂停（组头 ⏸ 共用；不收口不恢复主轨） */
  pause (): void
  /** 点击讲解气泡：从该片段起点开始播放。 */
  playLine (index: number): Promise<void>
  seekTo (sec: number): Promise<void>
  seekBy (deltaSec: number): Promise<void>
  setRate (rate: number): void
  /** 重播当前讲解稿（结束后"重新播放"；重新生成请用 start） */
  restart (): Promise<void>
  /** 文字追问：暂停主轨 → 同会话续问 → 播报回答 → 恢复原进度 */
  askText (text: string, opts?: { source?: 'voice' | 'text' }): Promise<void>
  /**
   * 组级重播:重新逐句合成播报指定组回答,播完恢复主轨断点;
   * 生成/组装进行中或录音中忽略;回答播报/挂起中(首次播报或另一组重播)则收口
   * 当前播报切换重播本组。本地重播,不发追问 run。
   */
  replayAnswer (groupId: string): void
  /**
   * 回答暂停中回主轨(主控播放入口):收口回答(组保留可重播),主轨按进度
   * 断点续播;已播完则从讲解开头重新播。续播前播语音过渡(见 continueCue)。
   */
  resumeMainTrack (): void
  startVoiceInput (opts?: { onLevel?: (rms: number) => void }): Promise<void>
  /**
   * 结束按住说话。
   * - `{ cancel: true }` 上滑取消：释放麦克风并丢弃录音，恢复录音前的播报
   * - `{ ask: false }` 回填模式：识别但不发送，返回 `{ text }` 供回填输入框手动发送
   * - 缺省：识别后直接走 askText 追问
   */
  stopVoiceInput (opts?: { cancel?: boolean, ask?: boolean }): Promise<{ text?: string } | void>
  /** 服务端打断语义适配（暂停/继续/跳过/结束）；正式指令格式待联调对齐 */
  handleControlIntent (intent: 'pause' | 'resume' | 'skip' | 'stop', payload?: { sec?: number }): void
  /**
   * 播放器（UI）可见性：隐藏即停播——暂停当前播报并停止后续合成调度，
   * 隐藏期成稿/追问收口不自动开播不合成；恢复显示时若隐藏前在播则从断点自动续播。
   */
  setVisible (visible: boolean): void
  subscribe (listener: (snapshot: ExplainStateSnapshot) => void): () => void
  destroy (): void
}

const newMessageId = (): string =>
  globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

export const createExplainController = (options: ExplainControllerOptions): ExplainController => {
  const { explainService, repository, synthesizer } = options
  const assembler = new ScriptAssembler({ duetMode: options.duetMode, lineIdPrefix: 'explain' })
  /** 回答轨道专用组装器：lineId 前缀 answer-，与主轨 explain- 区分 */
  const answerAssembler = new ScriptAssembler({ lineIdPrefix: 'answer' })

  let updating = false
  let updateFailed = false
  let sourceLabel = ''
  let contextHistory: ExplainContextHistory[] = []
  let latestUpdate: DataSourceUpdate | undefined
  let autoPlayAfterUpdate = true
  let scriptAutoPlay = true
  let cancellation: Promise<unknown> = Promise.resolve()
  let sessionId = ''
  let unsubscribe: (() => void) | null = null
  /** 本轮 run 的用途：首轮流=成稿；追问轮=回答 */
  let runKind: 'script' | 'answer' = 'script'
  let phase: ExplainPhase = 'idle'
  let answerStatus: ExplainStateSnapshot['answerStatus'] = 'none'
  let voiceState: ExplainStateSnapshot['voiceState'] = 'idle'
  let questionText = ''
  let answerText = ''
  let answerLines: ScriptLine[] = []
  let answerLineIndex = -1
  /** 回答定稿是否 JSON 讲解稿形态（行自带角色；纯文本回答走 answerQuestion 角色解析） */
  let answerFromDoc = false
  /** 回答逐行播报会话令牌：halt 后作废旧循环（restore=恢复主轨 / finalize=stop/destroy 收口） */
  let answerSession = 0
  let answerPlayback: ExplainStateSnapshot['answerPlayback'] = null
  let answerPlaybackLines: ScriptLine[] = []
  let answerProgressTimer: ReturnType<typeof setInterval> | null = null
  const clearAnswerProgress = () => { if (answerProgressTimer) clearInterval(answerProgressTimer); answerProgressTimer = null }
  /** 回答语音缓存：lineId → 句柄。追问回答内容固定，组级重播/切换重播命中缓存不再重新合成 */
  const answerVoiceCache = new Map<string, AudioHandle>()
  const answerMediaDurations = new Map<string, number>()
  /** 停当前回答音频并按语义退出播报循环 */
  let answerHalt: ((mode: 'restore' | 'finalize' | 'pause') => void) | null = null
  /** 回答播报暂停门控：置位后播报循环在句内断点挂起（不收口不恢复主轨），恢复后句内续播 */
  let answerPaused = false
  let robotConfig: RobotConfig | null = null
  let askEnabledExplicit = options.askEnabled
  let error: ExplainStateSnapshot['error'] = null
  /** 追问打断时保存的主轨进度（媒体秒），回答播完后恢复 */
  let resumePosition = 0
  let recorder: RecordController | null = null
  let startSequence = 0 // 快速重复 start 时作废旧链路
  /** 播放器可见性（UI 浮层）：隐藏期停播、停后续合成（见 bot.setVisible） */
  let presentationVisible = true
  /** 隐藏前在播 → 重开自动续播 */
  let wasPlayingBeforeHide = false
  /** 录音前在播 → 取消/识别失败时恢复播报（正常发送则移交 askText 断点机制） */
  let wasPlayingBeforeVoice = false
  /** 多次追问的对话分组(历史保留;每次 askText 追加) */
  const dialogGroups: ExplainDialogGroup[] = []
  /** 当前分析/播报中的组 id(收口后 null) */
  let activeGroupId: string | null = null
  /** 取活动组 */
  const activeGroup = () => dialogGroups.find(g => g.id === activeGroupId) || null

  /** 语音非发送收口（取消/识别失败/空文本）后恢复录音前正在播的讲解 */
  const resumeAfterVoice = () => {
    if (wasPlayingBeforeVoice) {
      wasPlayingBeforeVoice = false
      void bot.play()
    }
  }

  const listeners = new Set<(snapshot: ExplainStateSnapshot) => void>()
  let lastSnapshot: ExplainStateSnapshot | null = null

  const snapshot = (): ExplainStateSnapshot => ({
    phase, updating, updateFailed, sourceLabel, contextHistory,
    answerStatus,
    voiceState,
    questionText,
    answerText,
    answerLines,
    answerLineIndex,
    answerPlayback: answerPlayback ? { ...answerPlayback } : null,
    dialogGroups,
    activeGroupId,
    lines: player.script,
    lineStarts: player.script.map((_, i) => player.startAt(i)),
    currentLineIndex: progressLineIndex,
    currentTime: player.currentTime,
    duration: player.duration,
    robotConfig,
    isInterruptEnabled: askEnabledExplicit ?? (robotConfig?.isInterrupt ?? true),
    error,
  })
  const emit = () => {
    lastSnapshot = snapshot()
    for (const listener of listeners) listener(lastSnapshot)
  }
  const setPhase = (next: ExplainPhase) => { if (['idle', 'assembling', 'generating', 'error'].includes(next)) answerPlayback = null; if (phase !== next) { phase = next; emit() } }
  const setError = (kind: ExplainErrorKind, message: string) => { if (updating) { updating = false; updateFailed = true }; error = { kind, message }; setPhase('error') }

  const player = new DialoguePlayer({
    tts: synthesizer,
    onLineStart: () => {
      answerPlayback = null
      // 追问回答走独立句柄不经 player；这里只会是主轨开播
      if (phase !== 'playing') setPhase('playing')
    },
    onLineEnd: () => emit(),
    onFinished: () => setPhase('ended'),
    onAutoplayBlocked: () => {
      // 浏览器拦截自动播放：转暂停态引导用户手动点播放（不当作错误）
      setPhase('paused')
    },
    onProgress: () => emit(), // player 内部已节流 ~15Hz
    onError: () => { /* 单句合成失败已跳句；整体失败由 run 收口/降级链兜底 */ },
  })
  let progressLineIndex = -1
  // onProgress 里同步行索引（快照用），避免 UI 再从 player 反推
  player.onProgress = (p) => {
    progressLineIndex = p.lineIndex
    emit()
  }

  /** 等待 SSE 订阅就绪再发 runs，避免开头事件无人监听而丢失 */
  const subscribeAndWait = (taskId: string, onEvent: (event: TeldHubTaskEvent) => void): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false
      unsubscribe?.()
      unsubscribe = repository.subscribeTaskEvents(
        taskId,
        onEvent,
        (err) => {
          // sessionEventStream 对可重试错误自动退避重连；这里只收口终态错误
          const retryable = (err as { retryable?: boolean }).retryable !== false
          if (!retryable && !settled) { settled = true; reject(err) }
        },
        () => {
          if (!settled) { settled = true; resolve() }
        },
      )
    })

  const handleEvent = (event: TeldHubTaskEvent) => {
    if (event.type === 'session.error') {
      if (runKind === 'script') setError('generate-failed', event.text || '实时链路异常，请重新发起讲解')
      return
    }
    if (event.runState) {
      if (event.runState === 'failed') {
        if (runKind === 'script') setError('generate-failed', event.text || '讲解生成失败，请稍后重试')
        else finishAnswerRun(false)
      } else if (event.runState === 'completed' || event.runState === 'interrupted') {
        if (runKind === 'script') finishScriptRun()
        else finishAnswerRun(event.runState === 'completed')
      }
      return
    }
    // 思考/工具调用（agent.activity）不入讲解稿
    if (event.type !== 'agent.message' || !event.text) return
    if (runKind === 'script') {
      // 成稿以 durable message 为唯一正文来源：实测 text 为 JSON 讲解稿文档，
      // 流式增量对 JSON 无意义且与定稿双投递（durable 缺失的异常网关按 empty 收口）。
      if (event.streaming) return
      const lines = assembler.feedFinalDocument(event.text)
      if (lines.length) { player.appendLines(lines); emit() }
    } else {
      // 回答与成稿同源解析：流式增量忽略（JSON 碎片无意义），durable 定稿为唯一正文
      // （网关双投递下多次 durable 以最后一次为准，天然幂等）
      if (event.streaming) return
      const doc = extractScriptDoc(event.text)
      const lines = answerAssembler.feedFinalDocument(event.text)
      if (!lines.length) return
      answerFromDoc = !!doc
      answerLines = lines
      answerText = lines.map(l => l.text).join('\n')
      // 同步写入活动对话分组:回答行即时入组展示,播报高亮随后推进
      const group = activeGroup()
      if (group) { group.lines = lines; group.fromDoc = !!doc }
      emit()
    }
  }

  /** 首轮流收口：flush 残句 → 解读中 → 自动开播（需求 §2.1 生成完成自动播放） */
  const finishScriptRun = () => {
    const tail = assembler.flush()
    if (tail.length) player.appendLines(tail)
    if (!player.script.length) {
      setError('empty', '当前没有可讲解的内容')
      return
    }
    updating = false
    setPhase('interpreting')
    if (!scriptAutoPlay) { setPhase('paused'); return }
    // 播放器隐藏期不开播（首句合成请求也不发），重开后由用户手动播放
    if (!presentationVisible) {
      setPhase('paused')
      return
    }
    // play 内部首句合成请求期间保持"解读中"，onLineStart 转"播报中"
    void player.play()
  }

  /**
   * 追问回答的播报角色：voiceSetting 未配置时维持 'A'（现状）；配置了则取
   * 第一个 answerQuestion=true 的角色；一个都没有 → null（不播报，只展示文本）。
   */
  const resolveAnswerSpeaker = (cfg: RobotConfig | null): string | null => {
    const voices = cfg?.voiceSetting?.voices || []
    if (!voices.length) return 'A'
    return voices.find(v => v.answerQuestion)?.role ?? null
  }

  /**
   * 续播语音过渡:回到主轨前播一句衔接语,缓解打断后直接续播的生硬感。
   * 文案取 robotSet.ext.continueCue(缺省「好的，我们继续。」,显式空串关闭);
   * 合成/播放失败静默跳过不阻塞续播;句柄倍速跟随当前播放速率。
   */
  const playContinueCue = async () => {
    if (!presentationVisible) return
    const raw = robotConfig?.robotSet?.ext?.continueCue
    if (typeof raw === 'string' && raw.trim() === '') return
    const text = typeof raw === 'string' && raw.trim() ? raw.trim() : '好的，我们继续。'
    try {
      const speaker = player.script[0]?.speaker || 'A'
      const map = await synthesizer.synthesizeBatch([{ lineId: 'aeb-continue-cue', speaker, text }])
      const handle = map.get('aeb-continue-cue')
      if (!handle) return
      handle.rate = player.rate
      await handle.play()
    } catch { /* 过渡失败不阻塞续播 */ }
  }

  /** 回答收口后恢复主轨(或落 paused/ended);组级收口(done 置位)也在此统一处理 */  const restoreMainTrack = async () => {
    const group = activeGroup()
    if (group) group.done = true
    activeGroupId = null
    answerStatus = 'none'
    answerLineIndex = -1
    answerHalt = null
    answerPaused = false
    emit() // 收口即时可见（过渡句播放前快照先落定，观察者不看到陈旧播报态）
    if (!presentationVisible) {
      // 隐藏期不续播：askText 时已 pause 保断点，这里只回落暂停态
      setPhase(player.script.length ? 'paused' : phase)
      emit()
      return
    }
    if (player.duration > 0 && resumePosition < player.duration - 0.2) {
      // 主轨从打断点继续（显式 resume：断点保存时已 pause）
      await playContinueCue()
      // 过渡期间被打断/隐藏：不抢播（stop 已由意图方收口，隐藏回落暂停态）
      if (!presentationVisible || phase !== 'answering') {
        if (phase === 'answering') setPhase(player.script.length ? 'paused' : phase)
        emit()
        return
      }
      // seekTo 的 await 覆盖整段 resume 播放；期间新的追问/重播可能已接管（activeGroupId
      // 非空且 phase=answering）——此时恢复语义已被新意图取代,不得把新回答拉回 playing
      await player.seekTo(resumePosition, { resume: true })
      if (phase === 'answering' && activeGroupId === null) setPhase('playing')
    } else {
      setPhase(player.script.length ? 'ended' : phase)
    }
    emit()
  }

  /** 启动回答行逐句合成播报(与主轨同口径:单句请求 + 预取 2 句并发,首句最快出声),播完恢复主轨 */
  const startAnswerPlayback = (speakLines: ScriptLine[], startAt = 0, paused = false) => {
    clearAnswerProgress()
    answerPlaybackLines = speakLines
    const timeline = { groupId: activeGroupId || '', currentTime: startAt, duration: 0, ready: false }
    const cachedHandles = speakLines.map(line => answerVoiceCache.get(line.lineId))
    if (cachedHandles.every((handle, i) => handle && (handle.url == null || answerMediaDurations.has(speakLines[i].lineId)))) {
      timeline.duration = cachedHandles.reduce((sum, handle) => sum + handle!.duration, 0)
      timeline.ready = true
    }
    answerPlayback = timeline
    answerStatus = 'playing'
    answerLineIndex = -1
    answerPaused = paused
    if (paused) answerStatus = 'paused'
    emit()
    void (async () => {
      const session = ++answerSession
      let halted: 'restore' | 'finalize' | null = null
      let current: AudioHandle | null = null
      answerHalt = (mode) => {
        if (halted) return
        // pause 只停当前句音频（句柄 currentTime 保留，恢复句内续播），循环转挂起不退场
        if (mode === 'pause') { try { current?.stop() } catch { /* 忽略 */ } ; return }
        halted = mode
        clearAnswerProgress()
        answerHalt = null
        try { current?.stop() } catch { /* 忽略 */ }
      }
      /** 轮询等待恢复/作废；返回 false 表示期间被打断，调用方退出循环 */
      const waitResume = async () => {
        while (answerPaused && session === answerSession && !halted) {
          await new Promise(r => setTimeout(r, 80))
        }
        return !answerPaused && session === answerSession && !halted
      }
      let offset = 0
      let initialSeek = startAt
      const durations = new Map<number, number>()
      const publishDuration = () => {
        if (!timeline.ready && durations.size === speakLines.length && answerPlayback === timeline) {
          timeline.duration = [...durations.values()].reduce((sum, d) => sum + d, 0)
          timeline.ready = true
          emit()
        }
      }
      const register = (i: number, handle?: AudioHandle) => {
        const known = answerMediaDurations.get(speakLines[i].lineId)
        if (!handle || handle.url == null || known != null) durations.set(i, known ?? handle?.duration ?? 0)
        publishDuration()
      }
      try {
        const AHEAD = 2
        const inflight = new Map<number, Promise<Map<string, AudioHandle>>>()
        const ensure = (i: number): Promise<Map<string, AudioHandle>> => {
          const existing = inflight.get(i)
          if (existing) return existing
          if (i >= speakLines.length) return Promise.resolve(new Map())
          // 缓存命中:句柄进度归零,不再重新合成(重播/切换重播秒回)
          const cached = answerVoiceCache.get(speakLines[i].lineId)
          if (cached) {
            cached.reset()
            register(i, cached)
            const ready = Promise.resolve(new Map([[speakLines[i].lineId, cached]]))
            inflight.set(i, ready)
            return ready
          }
          const p = synthesizer.synthesizeBatch([speakLines[i]], { onMeta: (lineId, seconds) => {
            answerMediaDurations.set(lineId, seconds)
            durations.set(i, seconds)
            publishDuration()
          } })
            .then((map) => {
              const handle = map.get(speakLines[i].lineId)
              if (handle) answerVoiceCache.set(speakLines[i].lineId, handle)
              register(i, handle)
              return map
            })
            .catch((err) => {
              register(i)
              console.warn('[aeb-answer] 回答行合成失败，跳句', speakLines[i].lineId, err instanceof Error ? err.message : err)
              return new Map<string, AudioHandle>()
            })
          inflight.set(i, p)
          return p
        }
        for (let i = 0; i < speakLines.length; i++) {
          if (session !== answerSession || halted) break
          // 暂停请求落在句间（合成 await 期间）：本句先不出声，挂起等恢复再播
          if (answerPaused && !await waitResume()) break
          if (session !== answerSession || halted) break
          const pending = ensure(i)
          for (let k = 1; k <= AHEAD; k++) ensure(i + k) // 预取与当前句播放重叠
          const map = await pending
          if (session !== answerSession || halted) break
          const handle = map.get(speakLines[i].lineId)
          if (!handle) continue // 该句合成失败：跳句续播
          if (initialSeek >= offset + handle.duration && i < speakLines.length - 1) { offset += handle.duration; continue }
          answerLineIndex = i
          emit() // 行级高亮随对话流推进
          current = handle
          let fromSec = Math.max(0, initialSeek - offset)
          initialSeek = 0
          handle.rate = player.rate
          answerProgressTimer = setInterval(() => {
            if (session !== answerSession || halted || answerPlayback !== timeline) return
            timeline.currentTime = offset + handle.currentTime
            emit()
          }, 60)
          // 句内暂停/恢复：play 被暂停打断时挂起等恢复，醒来后本句从断点秒续播（i 不推进）
          for (;;) {
            await handle.play(fromSec)
            if (!(answerPaused && session === answerSession && !halted)) break
            fromSec = handle.currentTime
            if (!await waitResume()) break
            if (session !== answerSession || halted) break
          }
          if (session !== answerSession || halted) break
          clearAnswerProgress()
          if (!halted && session === answerSession) {
            offset += handle.duration
            timeline.currentTime = offset
            emit()
          }
          current = null
          if (session !== answerSession || halted) break
        }
      } catch { /* 降级链已尽力；无声直接恢复主轨 */ }
      if (session !== answerSession) return
      clearAnswerProgress()
      if (halted === 'finalize') return // stop/destroy 已收口，不再恢复主轨
      await restoreMainTrack()
    })()
  }

  /** 追问轮收口：回答行逐行合成播报（对话流高亮），完成后恢复主轨进度 */
  const finishAnswerRun = (hasAnswer: boolean) => {
    answerText = (hasAnswer ? answerText : '').trim()
    if (!hasAnswer) { answerLines = []; answerFromDoc = false }
    if (!hasAnswer || !answerLines.length) {
      void restoreMainTrack()
      return
    }
    // JSON 讲解稿回答：行自带角色直接播报；纯文本回答：取 answerQuestion 角色，
    // 配置了 voiceSetting 但无该角色 → 不播报只展示文本（现状语义）
    const plainSpeaker = answerFromDoc ? null : resolveAnswerSpeaker(robotConfig)
    if (!answerFromDoc && !plainSpeaker) {
      void restoreMainTrack()
      return
    }
    // 播放器隐藏期不做回答合成/播报，直接收口恢复
    if (!presentationVisible) {
      void restoreMainTrack()
      return
    }
    const speakLines = plainSpeaker ? answerLines.map(l => ({ ...l, speaker: plainSpeaker })) : answerLines
    startAnswerPlayback(speakLines)
  }

  const startRun = async (update?: DataSourceUpdate) => {
    const sequence = ++startSequence
    unsubscribe?.()
    unsubscribe = null
    const oldSession = sessionId
    sessionId = ''
    if (oldSession) cancellation = cancellation.then(() => repository.interruptTask(oldSession)).catch(() => {})
    answerHalt?.('finalize')
    answerHalt = null
    answerSession++
    recorder?.abort()
    recorder = null
    voiceState = 'idle'
    wasPlayingBeforeVoice = false
    if (update && (player.script.length || dialogGroups.length)) {
      contextHistory = [...contextHistory, { label: sourceLabel || '此前数据', lines: [...player.script], groups: dialogGroups.map(g => ({ ...g, lines: [...g.lines] })) }]
    } else if (!update) { contextHistory = []; sourceLabel = ''; latestUpdate = undefined; updating = false }
    player.load([])
    progressLineIndex = -1
    if (update) sourceLabel = update.label
    scriptAutoPlay = update ? autoPlayAfterUpdate : true
    updateFailed = false
    error = null
    assembler.reset()
    answerAssembler.reset()
    answerVoiceCache.clear() // lineId 序列随 reset 归零复用，旧会话语音缓存必须作废
    answerText = ''
    answerLines = []
    answerLineIndex = -1
    answerFromDoc = false
    questionText = ''
    dialogGroups.length = 0 // 重新讲解:历史对话分组清空
    activeGroupId = null
    runKind = 'script'
    setPhase('assembling')
    emit()
    let assembled: ExplainAssembleResult
    try {
      // mdSource 可异步（点击发起时才取数）：先解包再组装
      await cancellation
      if (update) await new Promise(resolve => setTimeout(resolve, 250))
      if (sequence !== startSequence) return
      const source = update?.mdSource || options.mdSource
      const md = source ? await source() : {}
      if (sequence !== startSequence) return
      assembled = await explainService.assembleExplain(options.configId, md)
    } catch (err) {
      if (sequence !== startSequence) return
      const code = err instanceof ExplainServiceError ? (err.errcode as ExplainServiceErrorCode) : ''
      if (code === '1002') setError('config-missing', err instanceof Error ? err.message : '对接配置不存在')
      else setError('assemble-failed', err instanceof Error ? err.message : '讲解暂时无法生成，请稍后重试')
      return
    }
    if (sequence !== startSequence) return
    sessionId = assembled.sessionId
    if (!assembled.messages?.length) {
      setError('empty', '当前没有可讲解的内容')
      return
    }
    try {
      // 先订阅就绪，再发送首轮流（多消息原样转发）
      await subscribeAndWait(sessionId, event => { if (sequence === startSequence) handleEvent(event) })
      if (sequence !== startSequence) return
      setPhase('generating')
      await repository.startTaskRunWithMessages(sessionId, assembled.messages, newMessageId())
    } catch (err) {
      if (sequence !== startSequence) return
      setError('generate-failed', err instanceof Error ? err.message : '讲解生成失败，请稍后重试')
    }
  }

  const bot: ExplainController = {
    async loadRobotConfig () {
      try {
        robotConfig = await explainService.queryRobotConfig(options.configId)
      } catch (err) {
        // 配置缺失不阻塞讲解（用默认外观）；1002 明确提示接入配置问题
        const code = err instanceof ExplainServiceError ? err.errcode : ''
        setError(code === '1002' ? 'config-missing' : 'assemble-failed',
          err instanceof Error ? err.message : '讲解配置加载失败')
        return
      }
      emit()
    },

    async start () { await startRun() },
    async refresh (update) {
      if (!updating && !updateFailed) autoPlayAfterUpdate = phase === 'playing' || (phase === 'answering' && answerStatus === 'playing')
      latestUpdate = update
      updating = true
      await startRun(update)
    },
    async retryRefresh () {
      if (!latestUpdate || !updateFailed) return
      updating = true
      await startRun(latestUpdate)
    },

    async play () {
      if (phase === 'ended' && answerPlayback?.groupId) { bot.replayAnswer(answerPlayback.groupId); return }
      // 回答播报暂停中：恢复句内续播（组头 ▶ 继续与主控共用此入口）
      if (phase === 'answering') {
        if (answerStatus !== 'paused') return
        answerPaused = false // 播报循环从挂起点醒来，当前句从断点秒续播
        answerStatus = 'playing'
        emit()
        return
      }
      if (phase === 'ended' || (player.script.length && player.currentTime >= player.duration - 0.2)) {
        player.rewind()
      }
      if (!player.script.length) return
      await player.play()
      // play 返回即播放循环结束（完成/被打断）；阶段由 onLineStart/onFinished 维护
    },

    pause () {
      // 回答播报中：句内暂停（停当前句音频，不收口不恢复主轨），组头 ⏸ 与主控共用此入口
      if (phase === 'answering') {
        if (answerStatus !== 'playing') return
        answerPaused = true
        answerHalt?.('pause')
        answerStatus = 'paused'
        emit()
        return
      }
      if (phase !== 'playing') return
      player.pause()
      setPhase('paused')
    },

    /**
     * 回答暂停中回主轨（主控播放入口）：收口回答（组保留可重播），主轨按进度
     * 断点续播；已播完则从讲解开头重新播。续播前播语音过渡缓解生硬感。
     */
    resumeMainTrack () {
      if (phase !== 'answering' || answerStatus !== 'paused') return
      answerPaused = false
      answerHalt?.('finalize') // 挂起循环置 halted 自行退出，其内部不再 restore
      answerHalt = null
      answerStatus = 'none'
      answerLineIndex = -1
      const group = activeGroup()
      if (group) group.done = true
      activeGroupId = null
      emit()
      void (async () => {
        if (player.duration > 0 && resumePosition < player.duration - 0.2) {
          await playContinueCue()
          // 过渡期间被打断/隐藏：不抢播
          if (!presentationVisible || phase !== 'answering') { emit(); return }
          await player.seekTo(resumePosition, { resume: true })
          if (phase === 'answering' && activeGroupId === null) setPhase('playing')
        } else {
          // 主轨已播完：从讲解开头重新播（rewind 后走 interpreting → onLineStart 转 playing）
          player.rewind()
          if (!presentationVisible) { setPhase('paused'); emit(); return }
          setPhase('interpreting')
          await player.play()
        }
        emit()
      })()
    },

    async playLine (index) {
      if (!Number.isInteger(index) || !player.script[index] || updating || updateFailed || voiceState !== 'idle') return
      if (!['playing', 'paused', 'ended', 'answering'].includes(phase)) return
      if (phase === 'answering') {
        if (answerStatus === 'analyzing') return
        answerPaused = false
        answerHalt?.('finalize')
        answerHalt = null
        const group = activeGroup()
        if (group) group.done = true
        answerStatus = 'none'
        answerLineIndex = -1
        activeGroupId = null
      }
      setPhase('interpreting')
      await player.seekTo(player.startAt(index), { resume: true })
    },

    async seekTo (sec: number) {
      if (answerPlayback && answerPlayback.ready && (phase === 'answering' || phase === 'ended')) {
        const group = dialogGroups.find(g => g.id === answerPlayback!.groupId)
        if (!group) return
        const target = Math.max(0, Math.min(sec, answerPlayback.duration))
        const paused = answerStatus === 'paused'
        answerHalt?.('finalize')
        activeGroupId = group.id
        answerLines = group.lines
        questionText = group.question
        setPhase('answering')
        startAnswerPlayback(answerPlaybackLines, target, paused)
        return
      }
      if (phase === 'answering') return
      await player.seekTo(sec, { resume: phase === 'playing' })
    },

    async seekBy (deltaSec: number) {
      await bot.seekTo((answerPlayback?.currentTime ?? player.currentTime) + deltaSec)
    },

    setRate (rate: number) {
      player.setRate(rate)
      for (const handle of answerVoiceCache.values()) handle.rate = rate
    },

    async restart () {
      answerPlayback = null
      player.rewind()
      await bot.play()
    },

    async askText (text: string, opts?: { source?: 'voice' | 'text' }) {
      const trimmed = (text || '').trim()
      if (!trimmed || !sessionId || phase === 'generating' || phase === 'assembling') return
      if (!snapshot().isInterruptEnabled) return
      // 回答播报暂停中允许继续追问：收口暂停组(保留可重播)，主轨保持停在断点
      if (phase === 'answering') {
        if (answerStatus !== 'paused') return
        answerPaused = false
        answerHalt?.('finalize') // 挂起循环置 halted 自行退出，其内部不再 restore
        answerHalt = null
        const pausedGroup = activeGroup()
        if (pausedGroup) pausedGroup.done = true
        answerStatus = 'none'
        answerLineIndex = -1
        activeGroupId = null
      }
      // 暂停主轨并记住断点；回答播完后 seekTo(resume, {resume:true}) 恢复
      if (phase === 'playing' || phase === 'interpreting') player.pause()
      resumePosition = Math.min(player.currentTime, player.duration || player.currentTime)
      answerPlayback = null
      questionText = trimmed
      answerText = ''
      answerLines = []
      answerLineIndex = -1
      answerFromDoc = false
      answerStatus = 'analyzing'
      runKind = 'answer'
      // 追加对话分组:断点即本次打断的主轨位置(进度条标记用)
      const group: ExplainDialogGroup = {
        id: newMessageId(),
        question: trimmed,
        source: opts?.source === 'voice' ? 'voice' : 'text',
        lines: [],
        fromDoc: false,
        done: false,
        breakpoint: resumePosition,
      }
      dialogGroups.push(group)
      activeGroupId = group.id
      setPhase('answering')
      emit() // 暂停回答后继续追问时 phase 不变，仍须发布新的分析状态。
      try {
        // 过渡实现：同会话续问（无 Skill 也可基于讲解内容与上下文回答）。
        // 正式"追问一揽子"契约（音频/文本 → 回答文本+音频流）待文档补充后切换。
        await repository.startTaskRun(sessionId, trimmed, newMessageId())
      } catch (err) {
        answerStatus = 'none'
        // 发起失败同样收口分组(不产生可重播的空组)
        const failed = activeGroup()
        if (failed) failed.done = true
        activeGroupId = null
        setError('generate-failed', err instanceof Error ? err.message : '回答生成失败，请稍后重试')
      }
    },

    replayAnswer (groupId: string) {
      // 守卫:生成/组装进行中或录音中忽略(避免与在途回答互踩)
      if (phase === 'assembling' || phase === 'generating') return
      if (voiceState !== 'idle') return
      const group = dialogGroups.find(g => g.id === groupId)
      if (!group || !group.lines.length) return
      // 已有回答播报/挂起(首次播报或另一组重播):收口它再切换,让任意组的 ▶ 随时可点;
      // 分析中(analyzing)的回答还在生成,仍忽略避免把未回答的组误标收口
      if (phase === 'answering') {
        if (answerStatus === 'analyzing') return
        answerPaused = false
        answerHalt?.('finalize') // 挂起循环置 halted 自行退出，其内部不再 restore
        answerHalt = null
        const current = activeGroup()
        if (current) current.done = true
        answerStatus = 'none'
        answerLineIndex = -1
        activeGroupId = null
      }
      // 主轨在播:暂停并记断点,播完恢复(与 askText 打断语义一致);切换场景主轨本就停在断点
      if (phase === 'playing' || phase === 'interpreting') player.pause()
      resumePosition = Math.min(player.currentTime, player.duration || player.currentTime)
      // 投影到活动组口径(answerLines 高亮/收口/隐藏期语义全部复用)
      questionText = group.question
      answerText = group.lines.map(l => l.text).join('\n')
      answerLines = group.lines
      answerFromDoc = group.fromDoc
      activeGroupId = group.id
      setPhase('answering')
      // 角色解析与追问收口同规则:纯文本回答取 answerQuestion 角色,无该角色则不播报直接收口
      const plainSpeaker = group.fromDoc ? null : resolveAnswerSpeaker(robotConfig)
      if (!group.fromDoc && !plainSpeaker) { void restoreMainTrack(); return }
      const speakLines = plainSpeaker ? group.lines.map(l => ({ ...l, speaker: plainSpeaker })) : group.lines
      startAnswerPlayback(speakLines)
    },

    async startVoiceInput (opts?: { onLevel?: (rms: number) => void }) {
      if (voiceState !== 'idle') return
      if (!supportsRecording()) {
        setError('asr-failed', '当前环境不支持录音，请检查麦克风权限')
        return
      }
      const sequence = startSequence
      try {
        const acquired = await startRecording(opts)
        if (sequence !== startSequence) { acquired.abort(); return }
        recorder = acquired
        // 录音期间暂停播报：避免麦克风拾到播报声，用户也听得清自己说话
        if (phase === 'playing') {
          player.pause()
          setPhase('paused')
          wasPlayingBeforeVoice = true
        }
        voiceState = 'recording'
        emit()
      } catch {
        if (sequence !== startSequence) return
        setError('asr-failed', '麦克风不可用，请检查权限设置')
      }
    },

    async stopVoiceInput (opts?: { cancel?: boolean, ask?: boolean }): Promise<{ text?: string } | void> {
      const sequence = startSequence
      const current = recorder
      if (!current || voiceState !== 'recording') return
      recorder = null
      // 上滑取消：释放麦克风并丢弃录音，恢复录音前的播报
      if (opts?.cancel === true) {
        voiceState = 'idle'
        emit()
        try { await current.stop() } catch { /* 仅释放麦克风，结果丢弃 */ }
        resumeAfterVoice()
        return
      }
      voiceState = 'recognizing'
      emit()
      try {
        const recording = await current.stop()
        if (sequence !== startSequence) return
        const { text } = await explainService.recognizeSpeech(recording.data, recording.format)
        if (sequence !== startSequence) return
        if (!text.trim()) {
          voiceState = 'idle'
          setError('asr-failed', '未能识别出语音内容，请重试')
          resumeAfterVoice()
          return
        }
        voiceState = 'idle'
        emit()
        if (opts?.ask === false) {
          // 回填模式：识别但不发送，主轨保持暂停（内容由用户编辑/手动发送）
          return { text }
        }
        // 正常发送：恢复职责移交 askText 的断点续播机制
        wasPlayingBeforeVoice = false
        await bot.askText(text, { source: 'voice' })
      } catch (err) {
        if (sequence !== startSequence) return
        voiceState = 'idle'
        // 识别失败按问答时序单独提示，不当作讲解错误打断整体状态；恢复录音前的播报
        error = { kind: 'asr-failed', message: err instanceof Error ? err.message : '语音识别失败，请重试' }
        emit()
        resumeAfterVoice()
      }
    },

    handleControlIntent (intent, payload) {
      if (intent === 'pause') bot.pause()
      else if (intent === 'resume') void bot.play()
      else if (intent === 'stop') {
        player.pause()
        answerHalt?.('finalize')
        answerStatus = 'none'
        answerLineIndex = -1
        answerPaused = false // 暂停挂起中的循环随 finalize 作废，门控一并复位
        wasPlayingBeforeHide = false // 显式结束：重开不再自动续播
        // interrupt 只中断当前 run，会话保留；「结束讲解」由 phase=ended 表达
        if (sessionId) void repository.interruptTask(sessionId)
        setPhase('ended')
      } else if (intent === 'skip') {
        // 跳过：显式 sec 优先；默认跳过当前句继续后续内容。正式语义待联调对齐。
        if (payload?.sec != null) { void bot.seekTo(payload.sec); return }
        const nextIndex = player.currentIndex + 2 // 游标前置一位约定：+2 = 当前句的下一句
        const target = player.startAt(Math.min(nextIndex, player.script.length - 1))
        void bot.seekTo(target)
      }
    },

    setVisible (visible: boolean) {
      if (visible === presentationVisible) return
      presentationVisible = visible
      if (!visible) {
        // 隐藏即停播：停当前句并让播放循环退出，预取调度随之中止
        // （在途 ≤ 预取窗口的请求落缓存，续播直接命中不浪费）
        wasPlayingBeforeHide = phase === 'playing' || phase === 'interpreting'
        player.pause()
        answerHalt?.('restore')
        if (phase === 'playing' || phase === 'interpreting') setPhase('paused')
        emit()
      } else if (wasPlayingBeforeHide) {
        // 重开自动续播：仅隐藏前在播才续（暂停/未播/已结束不动）
        wasPlayingBeforeHide = false
        void bot.play()
      }
    },

    subscribe (listener) {
      listeners.add(listener)
      listener(lastSnapshot || snapshot())
      return () => listeners.delete(listener)
    },

    destroy () {
      clearAnswerProgress()
      startSequence++
      answerHalt?.('finalize')
      recorder?.abort()
      player.destroy()
      unsubscribe?.()
      unsubscribe = null
      listeners.clear()
    },
  }

  return bot
}
