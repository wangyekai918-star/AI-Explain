import { describe, expect, it, vi } from 'vitest'
import { createExplainController, type ExplainStateSnapshot } from './ExplainController'
import { ExplainServiceClient, ExplainServiceError } from './explainServiceClient'
import type { ScriptLine } from './dialoguePlayer'
import { makeSilenceHandle, type TtsSynthesizer } from './ttsEngine'
import type { RestTeldHubSessionRepository } from './rest/RestTeldHubSessionRepository'
import type { TeldHubTaskEvent } from '../types'

/** recorder 可控 mock：默认不支持录音（保持既有 asr-failed 用例路径），语音用例里切换 */
const recorderCtl = vi.hoisted(() => {
  const state = { supports: false, result: undefined as { data: string, format: string } | undefined }
  return {
    supportsRecording: vi.fn(() => state.supports),
    startRecording: vi.fn(async () => ({ stop: async () => state.result! })),
    __set: (v: Partial<typeof state>) => { Object.assign(state, v) },
    __reset: () => { state.supports = false; state.result = undefined },
  }
})
vi.mock('./recorder', () => recorderCtl)

/** 高速静音合成器：媒体秒 ×16 推进，测试秒级完成 */
const fastSynth: TtsSynthesizer = {
  synthesizeBatch: async lines => new Map(lines.map((l) => {
    const handle = makeSilenceHandle(l.text)
    handle.rate = 16
    return [l.lineId, handle]
  })),
}

type RepositoryHarness = {
  repository: RestTeldHubSessionRepository
  emit: (event: Partial<TeldHubTaskEvent>) => void
  runs: Array<{ messages: Array<{ id: string, role: string, content: string }>, text?: string }>
  interrupts: number
}

const createRepositoryHarness = (): RepositoryHarness => {
  let handler: ((event: TeldHubTaskEvent) => void) | null = null
  const harness: RepositoryHarness = {
    runs: [],
    interrupts: 0,
    emit (event) { handler?.(event as TeldHubTaskEvent) },
    repository: {
      subscribeTaskEvents: vi.fn((_taskId: string, onEvent: (e: TeldHubTaskEvent) => void, _onError?: unknown, onConnected?: () => void) => {
        handler = onEvent
        setTimeout(() => onConnected?.(), 0)
        return () => { handler = null }
      }),
      startTaskRunWithMessages: vi.fn(async (_taskId: string, messages: Array<{ id: string, role: string, content: string }>) => {
        harness.runs.push({ messages })
        return []
      }),
      startTaskRun: vi.fn(async (_taskId: string, text: string) => {
        harness.runs.push({ messages: [], text })
        return []
      }),
      interruptTask: vi.fn(async () => {
        harness.interrupts++
        return { id: 'ses_1', expertId: '', prompt: '', model: 'Auto', context: [], state: 'completed', plan: [] }
      }),
    } as unknown as RestTeldHubSessionRepository,
  }
  return harness
}

const createServiceMock = (overrides: Partial<Record<'assemble' | 'recognize', Parameters<typeof vi.fn>[0]>> = {}) => {
  const assemble = vi.fn(overrides.assemble || (async () => ({
    sessionId: 'ses_1',
    messages: [
      { id: 'sys-1', role: 'system', content: '你是讲解助手' },
      { id: 'user-1', role: 'user', content: '# MD' },
    ],
  }))) as unknown as ReturnType<typeof vi.fn>
  const recognize = vi.fn(overrides.recognize || (async () => ({ text: '为什么增长', durationMs: 100 }))) as unknown as ReturnType<typeof vi.fn>
  const client = {
    queryRobotConfig: vi.fn(async () => ({ isInterrupt: true, robotSet: {} })),
    assembleExplain: assemble,
    recognizeSpeech: recognize,
  } as unknown as ExplainServiceClient
  return { client, assemble, recognize }
}

const aguiDelta = (text: string, messageId = 'run-1'): Partial<TeldHubTaskEvent> => ({
  id: `assistant:${messageId}`, taskId: 'ses_1', type: 'agent.message', text, streaming: true, runMessageId: messageId,
})

/** durable 定稿形态（streaming:false）：讲解稿轨道的唯一正文源 */
const durableScript = (text: string, messageId = 'run-1'): Partial<TeldHubTaskEvent> => ({
  id: `assistant:${messageId}`, taskId: 'ses_1', type: 'agent.message', text, streaming: false,
})

const waitFor = async (predicate: () => boolean, timeout = 8000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor 超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('ScriptAssembler（经控制器行为覆盖）', () => {
  it('cuts a durable plain-text script into sentences', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    const phases: ExplainStateSnapshot['phase'][] = []
    const linesSeen: ScriptLine[] = []
    controller.subscribe(s => {
      if (phases[phases.length - 1] !== s.phase) phases.push(s.phase)
      if (s.lines.length > linesSeen.length) linesSeen.push(...s.lines.slice(linesSeen.length))
    })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    harness.emit(durableScript('本季度销量一二三四五六七八九十。环比增长 8%，主要来自新电站。\n\n'))
    await waitFor(() => linesSeen.length >= 2)
    harness.emit({ runState: 'completed' })
    await waitFor(() => phases.includes('ended') || phases.includes('error'), 8000)
    expect(linesSeen.map(l => l.text)).toEqual(['本季度销量一二三四五六七八九十。', '环比增长 8%，主要来自新电站。'])
    expect(linesSeen.every(l => l.speaker === 'A')).toBe(true) // 单人模式恒 A
    controller.destroy()
  })

  it('takes the script only from the durable message when deltas and final both arrive', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    // 真实网关双投递：流式增量（JSON 碎片）必须被忽略，durable 定稿是唯一正文源
    harness.emit(aguiDelta('{"ti'))
    harness.emit(aguiDelta('tle":"x"}'))
    harness.emit(durableScript(JSON.stringify({ title: 't', script: [
      { speaker: 'A', text: '第一句。' },
      { speaker: 'B', text: '第二句。' },
    ] })))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'ended' || latest!.phase === 'error', 8000)
    expect(latest!.lines.map(l => [l.speaker, l.text])).toEqual([
      ['A', '第一句。'],
      ['B', '第二句。'],
    ])
    controller.destroy()
  })
})

describe('ExplainController', () => {
  it('forwards assembleExplain messages verbatim to the first run', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    expect(harness.runs[0]?.messages).toEqual([
      { id: 'sys-1', role: 'system', content: '你是讲解助手' },
      { id: 'user-1', role: 'user', content: '# MD' },
    ])
    controller.destroy()
  })

  it('mdSource 支持 Promise：start 时解包异步结果传给 assembleExplain', async () => {
    const harness = createRepositoryHarness()
    const { client, assemble } = createServiceMock()
    let fetched = false
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
      mdSource: async () => {
        await new Promise(r => setTimeout(r, 20))
        fetched = true
        return { mdContext: '# 异步拉取的 MD' }
      },
    })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    expect(fetched).toBe(true)
    expect(assemble).toHaveBeenCalledWith('1001', { mdContext: '# 异步拉取的 MD' })
    controller.destroy()
  })

  it('surfaces empty script and failed runs as mapped error states', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    const snapshots: ExplainStateSnapshot[] = []
    controller.subscribe(s => snapshots.push({ ...s }))
    await controller.start()
    harness.emit({ runState: 'failed' })
    await waitFor(() => snapshots[snapshots.length - 1].phase === 'error')
    expect(snapshots[snapshots.length - 1].error).toMatchObject({ kind: 'generate-failed' })
    controller.destroy()
  })

  it('maps 1002 assemble failures to config-missing', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock({
      assemble: async () => { throw new ExplainServiceError('[AIP-Mgr-assembleExplain 1002] 对接配置不存在', '1002', '对接配置不存在') },
    })
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: 'bad',
    })
    const latest = { snapshot: null as ExplainStateSnapshot | null }
    controller.subscribe(s => { latest.snapshot = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    await waitFor(() => latest.snapshot!.phase === 'error')
    expect(latest.snapshot!.error).toMatchObject({ kind: 'config-missing' })
    controller.destroy()
  })

  it('plays through to ended after the script run completes', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    const phases: ExplainStateSnapshot['phase'][] = []
    controller.subscribe(s => { if (phases[phases.length - 1] !== s.phase) phases.push(s.phase) })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。第三句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => phases.includes('ended'))
    expect(phases).toContain('generating')
    expect(phases).toContain('playing')
    expect(phases[phases.length - 1]).toBe('ended')
    controller.destroy()
  })

  it('pauses the main track on ask and restores it after the answer is spoken', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。第三句。第四句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    await waitFor(() => latest!.currentTime > 0.1)

    await controller.askText('为什么增长')
    await waitFor(() => latest!.answerStatus === 'analyzing')
    expect(latest!.questionText).toBe('为什么增长')

    harness.emit(aguiDelta('因为新电站放量。', 'run-2'))
    // 流式增量被忽略，durable 定稿是回答唯一正文（与成稿同源）
    harness.emit(durableScript('因为新电站放量。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest!.answerStatus === 'playing') // 回答整段播报中
    expect(latest!.answerText).toBe('因为新电站放量。')
    await waitFor(() => latest!.answerStatus === 'none' && latest!.phase === 'playing', 10000)
    // 主轨从断点恢复继续播
    expect(latest!.currentTime).toBeGreaterThan(0)
    controller.destroy()
  })

  it('answers with the first answerQuestion voice role from voiceSetting', async () => {
    const harness = createRepositoryHarness()
    const spoken: Array<{ lineId: string, speaker: string, text: string }> = []
    const synth: TtsSynthesizer = {
      synthesizeBatch: async lines => new Map(lines.map((l) => {
        spoken.push({ lineId: l.lineId, speaker: l.speaker, text: l.text })
        const handle = makeSilenceHandle(l.text)
        handle.rate = 16
        return [l.lineId, handle]
      })),
    }
    const { client } = createServiceMock()
    ;(client as unknown as { queryRobotConfig: (id: string) => Promise<unknown> }).queryRobotConfig = vi.fn(async () => ({
      isInterrupt: true,
      robotSet: {},
      voiceSetting: { roleDivisionId: '1', voices: [
        { role: 'A', displayName: '小电', answerQuestion: false },
        { role: 'B', displayName: '小特', answerQuestion: true },
      ] },
    }))
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: synth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    await controller.loadRobotConfig()
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    await controller.askText('为什么增长')
    harness.emit(durableScript('因为新电站放量。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest!.answerStatus === 'playing')
    // 纯文本回答按 answerQuestion 角色逐行播报（行 ID 前缀 answer-）
    expect(spoken.at(-1)).toMatchObject({ speaker: 'B', text: '因为新电站放量。' })
    expect(spoken.at(-1)!.lineId.startsWith('answer-')).toBe(true)
    controller.destroy()
  })

  it('skips answer speech when no voice has answerQuestion', async () => {
    const harness = createRepositoryHarness()
    const spoken: Array<{ lineId: string, speaker: string, text: string }> = []
    const synth: TtsSynthesizer = {
      synthesizeBatch: async lines => new Map(lines.map((l) => {
        spoken.push({ lineId: l.lineId, speaker: l.speaker, text: l.text })
        const handle = makeSilenceHandle(l.text)
        handle.rate = 16
        return [l.lineId, handle]
      })),
    }
    const { client } = createServiceMock()
    ;(client as unknown as { queryRobotConfig: (id: string) => Promise<unknown> }).queryRobotConfig = vi.fn(async () => ({
      isInterrupt: true,
      robotSet: {},
      voiceSetting: { voices: [
        { role: 'A', displayName: '小电', answerQuestion: false },
        { role: 'B', displayName: '小特', answerQuestion: false },
      ] },
    }))
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: synth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    await controller.loadRobotConfig()
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    await controller.askText('为什么增长')
    harness.emit(durableScript('因为新电站放量。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    // 不播报：回答文本照常展示（answerText 有值），answerStatus 不经 playing 直接回 none
    await waitFor(() => latest!.answerStatus === 'none' && latest!.phase === 'playing', 8000)
    expect(latest!.answerText).toContain('新电站')
    expect(spoken.some(l => l.lineId.startsWith('answer-'))).toBe(false)
    controller.destroy()
  })

  it('extracts joined script texts when the answer arrives as a JSON document (same as script track)', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const spoken: Array<{ lineId: string, text: string }> = []
    const batchSizes: number[] = []
    const synth: TtsSynthesizer = {
      synthesizeBatch: async lines => {
        batchSizes.push(lines.length) // 追问与主轨同口径：一次请求只传单句
        spoken.push(...lines.map(l => ({ lineId: l.lineId, text: l.text })))
        return new Map(lines.map((l) => {
          const handle = makeSilenceHandle(l.text)
          handle.rate = 16
          return [l.lineId, handle]
        }))
      },
    }
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: synth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    await controller.askText('为什么增长')
    // 双投递：流式 JSON 碎片必须被忽略（不构成回答正文）
    harness.emit(aguiDelta('{"ti', 'run-2'))
    harness.emit(aguiDelta('tle":"x"}', 'run-2'))
    // durable 定稿：前导说明 + 内嵌 JSON 讲解稿（与成稿同形态）
    harness.emit(durableScript('任务(role)，双人模式。\n\n' + JSON.stringify({ title: '追问回答', script: [
      { speaker: 'A', text: '因为新电站放量。' },
      { speaker: 'B', text: '成本端保持平稳。' },
    ] }), 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest!.answerStatus === 'playing')
    expect(latest!.answerText).toBe('因为新电站放量。\n成本端保持平稳。') // 行文拼接，非原始 JSON
    expect(latest!.answerLines.map(l => [l.speaker, l.text])).toEqual([
      ['A', '因为新电站放量。'],
      ['B', '成本端保持平稳。'],
    ])
    await waitFor(() => latest!.answerStatus === 'none', 10000)
    // 逐行播报：两行各自合成（answer- 前缀），文本与回答行同源
    expect(spoken.filter(l => l.lineId.startsWith('answer-')).map(l => l.text)).toEqual(['因为新电站放量。', '成本端保持平稳。'])
    expect(batchSizes.every(n => n === 1)).toBe(true) // 单句请求（多次请求），不整批等待
    controller.destroy()
  })

  it('stops on the stop intent: pauses playback and interrupts the current run', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    controller.handleControlIntent('stop')
    await waitFor(() => latest!.phase === 'ended')
    expect(harness.interrupts).toBe(1)
    controller.destroy()
  })

  it('reports asr-failed when the environment cannot record', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    await controller.startVoiceInput() // jsdom 无 getUserMedia
    await waitFor(() => latest!.error?.kind === 'asr-failed')
    controller.destroy()
  })
})

describe('ExplainController 语音输入（录音暂停/上滑取消/回填）', () => {
  /** 把讲解播到 playing：start → durable 定稿 → 自动开播 */
  const startToPlaying = async () => {
    const harness = createRepositoryHarness()
    const { client, recognize } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001',
    })
    const latest = { s: null as ExplainStateSnapshot | null }
    controller.subscribe(s => { latest.s = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进
    await controller.start()
    harness.emit(durableScript('本季度销量一二三四五六七八九十。环比增长 8%，主要来自新电站。\n\n'))
    harness.emit({ runState: 'completed' }) // 成稿收口 → interpreting → 自动开播
    await waitFor(() => latest.s?.phase === 'playing')
    return { harness, recognize, controller, latest }
  }

  const enterRecording = async (controller: ReturnType<typeof createExplainController>) => {
    recorderCtl.__set({ supports: true, result: { data: 'audio-base64', format: 'wav' } })
    await controller.startVoiceInput()
  }

  it('录音期间自动暂停播报，上滑取消后丢弃录音并从断点恢复', async () => {
    const { recognize, controller, latest } = await startToPlaying()
    await enterRecording(controller)
    await waitFor(() => latest.s?.phase === 'paused') // 录音即暂停，避免拾音混入播报声

    await controller.stopVoiceInput({ cancel: true })
    expect(recognize).not.toHaveBeenCalled() // 取消：丢弃录音不识别
    await waitFor(() => latest.s?.phase === 'playing') // 从暂停点恢复播报
    expect(latest.s?.voiceState).toBe('idle')
    controller.destroy()
    recorderCtl.__reset()
  })

  it('ask:false 识别不发送，返回文本供回填输入框', async () => {
    const { harness, recognize, controller, latest } = await startToPlaying()
    await enterRecording(controller)
    const result = await controller.stopVoiceInput({ ask: false })
    expect(result).toEqual({ text: '为什么增长' })
    expect(recognize).toHaveBeenCalledTimes(1)
    expect(harness.runs).toHaveLength(1) // 仅首轮讲解 run，未发追问
    expect(latest.s?.phase).toBe('paused') // 回填待发送，主轨保持暂停
    controller.destroy()
    recorderCtl.__reset()
  })

  it('识别失败恢复播报（asr-failed 不打断讲解）', async () => {
    const { recognize, controller, latest } = await startToPlaying()
    ;(recognize as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('asr down'))
    await enterRecording(controller)
    await controller.stopVoiceInput()
    await waitFor(() => latest.s?.phase === 'playing')
    expect(latest.s?.voiceState).toBe('idle')
    controller.destroy()
    recorderCtl.__reset()
  })

  it('正常发送：识别后走 askText 追问', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await enterRecording(controller)
    await controller.stopVoiceInput()
    await waitFor(() => latest.s?.phase === 'answering')
    expect(harness.runs).toHaveLength(2) // 首轮讲解 + 追问 run
    expect(latest.s?.dialogGroups[0]).toMatchObject({ question: '为什么增长', source: 'voice' }) // 分组来源标记语音
    controller.destroy()
    recorderCtl.__reset()
  })
})

describe('ExplainController 对话分组与组级重播', () => {
  /** 记录合成请求行的快速合成器(媒体秒 ×16 推进) */
  const createRecordingSynth = () => {
    const spoken: Array<{ lineId: string, speaker: string, text: string }> = []
    const synth: TtsSynthesizer = {
      synthesizeBatch: async lines => new Map(lines.map((l) => {
        spoken.push({ lineId: l.lineId, speaker: l.speaker, text: l.text })
        const handle = makeSilenceHandle(l.text)
        handle.rate = 16
        return [l.lineId, handle]
      })),
    }
    return { spoken, synth }
  }

  /** 慢速合成（rate=4，每句约 1s）+ 请求行记录：供暂停窗口与过渡句断言 */
  const createSlowSynth = () => {
    const requested: Array<{ lineId: string, text: string }> = []
    const synth: TtsSynthesizer = {
      synthesizeBatch: async lines => {
        requested.push(...lines.map(l => ({ lineId: l.lineId, text: l.text })))
        return new Map(lines.map((l) => {
          const handle = makeSilenceHandle(l.text)
          handle.rate = 4
          return [l.lineId, handle]
        }))
      },
    }
    return { requested, synth }
  }

  /** 把讲解播到 playing:start → durable 定稿 → 自动开播；可注入合成器（默认高速静音） */
  const startToPlaying = async (overrides: { synthesizer?: TtsSynthesizer } = {}) => {
    const harness = createRepositoryHarness()
    const { spoken, synth } = createRecordingSynth()
    const { client } = createServiceMock()
    const controller = createExplainController({
      explainService: client, repository: harness.repository,
      synthesizer: overrides.synthesizer || synth, configId: '1001',
    })
    const latest = { s: null as ExplainStateSnapshot | null }
    controller.subscribe(s => { latest.s = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进
    await controller.start()
    return { harness, spoken, controller, latest }
  }

  const playScript = async (harness: ReturnType<typeof createRepositoryHarness>, latest: { s: ExplainStateSnapshot | null }) => {
    harness.emit(durableScript('第一句。第二句。第三句。第四句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest.s?.phase === 'playing')
  }

  it('多次追问成组保留:来源、回答行、断点与收口状态正确', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1) // 主轨推进一段再打断,断点非零
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering') // 收口完成(主轨恢复),避开收口窗口
    // 主轨恢复续播中再次追问
    await controller.askText('第二问')
    harness.emit(durableScript('答二甲。答二乙。', 'run-3'))
    harness.emit({ runState: 'completed', id: 'done-3' })
    await waitFor(() => latest.s!.dialogGroups[1]?.done)
    const groups = latest.s!.dialogGroups
    expect(groups.map(g => [g.question, g.source, g.done])).toEqual([
      ['第一问', 'text', true],
      ['第二问', 'text', true],
    ])
    expect(groups[0].lines.map(l => l.text)).toEqual(['答一。'])
    expect(groups[1].lines.map(l => l.text)).toEqual(['答二甲。', '答二乙。'])
    expect(groups[1].breakpoint).toBeGreaterThanOrEqual(groups[0].breakpoint) // 断点随主轨推进后移
    expect(groups.every(g => g.breakpoint > 0)).toBe(true)
    expect(latest.s!.activeGroupId).toBeNull() // 收口后无活动组
    controller.destroy()
  })

  it('start 重新讲解清空对话分组', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await controller.start()
    expect(latest.s!.dialogGroups).toHaveLength(0)
    expect(latest.s!.activeGroupId).toBeNull()
    controller.destroy()
  })

  it('stop 意图结束讲解后分组保留(历史可重播)', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    controller.handleControlIntent('stop')
    await waitFor(() => latest.s!.phase === 'ended')
    expect(latest.s!.dialogGroups).toHaveLength(1)
    controller.destroy()
  })

  it('三段回答共用累计时间，暂停、跨段拖动及新追问正确切换', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await waitFor(() => latest.s!.phase === 'ended')
    controller.setRate(1)
    await controller.askText('分三段回答')
    harness.emit(durableScript('第一段回答。第二段回答。第三段回答。', 'answer-three'))
    harness.emit({ runState: 'completed', id: 'answer-three-done' })
    await waitFor(() => !!latest.s!.answerPlayback?.ready)
    const total = latest.s!.answerPlayback!.duration
    expect(total).toBeGreaterThan(0)
    await waitFor(() => (latest.s!.answerPlayback?.currentTime || 0) > .05)
    controller.pause()
    const stopped = latest.s!.answerPlayback!.currentTime
    await new Promise(r => setTimeout(r, 140))
    expect(Math.abs(latest.s!.answerPlayback!.currentTime - stopped)).toBeLessThan(.15)
    await controller.seekTo(total * .8)
    expect(latest.s!.answerStatus).toBe('paused')
    expect(latest.s!.answerPlayback!.ready).toBe(true)
    expect(latest.s!.answerPlayback!.currentTime).toBeCloseTo(total * .8)
    await controller.play()
    await waitFor(() => latest.s!.answerLineIndex === 2)
    expect(latest.s!.answerPlayback!.duration).toBeCloseTo(total)
    controller.setRate(16)
    await waitFor(() => latest.s!.phase === 'ended')
    expect(latest.s!.answerPlayback!.currentTime).toBeCloseTo(total)
    controller.replayAnswer(latest.s!.dialogGroups[0].id)
    await waitFor(() => latest.s!.answerStatus === 'playing')
    controller.pause()
    await waitFor(() => latest.s!.answerStatus === 'paused')
    const asking = controller.askText('新问题')
    await asking
    expect(latest.s!.answerStatus).toBe('analyzing')
    expect(latest.s!.answerPlayback).toBeNull()
    controller.destroy()
  })

  it('replayAnswer 重播指定组回答(逐句合成,不发 run),播完恢复主轨', async () => {
    const { harness, spoken, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1)
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering') // 主轨恢复续播后再重播
    const runsBefore = harness.runs.length
    const groupId = latest.s!.dialogGroups[0].id
    controller.replayAnswer(groupId)
    await waitFor(() => latest.s!.activeGroupId === groupId)
    expect(latest.s!.phase).toBe('answering')
    expect(harness.runs).toHaveLength(runsBefore) // 本地重播,不发追问 run
    await waitFor(() => latest.s!.answerStatus === 'none', 10000)
    expect(latest.s!.activeGroupId).toBeNull()
    // 重播命中语音缓存:首次播报合成一次,重播不再发合成请求
    expect(spoken.filter(l => l.lineId.startsWith('answer-')).map(l => l.text)).toEqual(['答一。'])
    controller.destroy()
  })

  it('answering 期间 replayAnswer 被忽略', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering') // 收口完成再发起第二问
    await controller.askText('第二问')
    await waitFor(() => latest.s!.phase === 'answering')
    const doneGroup = latest.s!.dialogGroups[0]
    const runsBefore = harness.runs.length
    controller.replayAnswer(doneGroup.id)
    expect(latest.s!.activeGroupId).not.toBe(doneGroup.id) // 活动组仍是第二问
    expect(harness.runs).toHaveLength(runsBefore)
    controller.destroy()
  })

  it('回答播报中点击另一收口组 ▶：收口当前播报组并切换重播目标组', async () => {
    const { harness, controller, latest } = await startToPlaying()
    await playScript(harness, latest)
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1)
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering')
    await controller.askText('第二问')
    harness.emit(durableScript('答二。', 'run-3'))
    harness.emit({ runState: 'completed', id: 'done-3' })
    await waitFor(() => latest.s!.dialogGroups[1]?.done)
    await waitFor(() => latest.s!.phase !== 'answering')
    const [g1, g2] = latest.s!.dialogGroups
    controller.replayAnswer(g1.id)
    await waitFor(() => latest.s!.answerStatus === 'playing')
    expect(latest.s!.activeGroupId).toBe(g1.id)
    controller.replayAnswer(g2.id) // 第一组播报中直接切到第二组
    await waitFor(() => latest.s!.activeGroupId === g2.id)
    expect(latest.s!.dialogGroups[0].done).toBe(true) // 第一组收口(保留可重播)
    expect(latest.s!.answerStatus).toBe('playing')
    await waitFor(() => latest.s!.answerStatus === 'none', 10000) // 第二组播完收口
    expect(latest.s!.activeGroupId).toBeNull()
    controller.destroy()
  })

  it('组级重播可暂停/继续：句内停声不收口，恢复后续播到收口', async () => {
    const { synth: slowSynth } = createSlowSynth()
    const { harness, controller, latest } = await startToPlaying({ synthesizer: slowSynth })
    await playScript(harness, latest)
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1)
    await controller.askText('第一问')
    harness.emit(durableScript('答一句比较长的话术内容方便暂停操作。答二也是比较长的内容方便观察。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering') // 首次播报收口后再重播
    const groupId = latest.s!.dialogGroups[0].id
    controller.replayAnswer(groupId)
    await waitFor(() => latest.s!.answerStatus === 'playing')
    await waitFor(() => latest.s!.answerLineIndex >= 1) // 推进到第二句
    controller.pause()
    expect(latest.s!.answerStatus).toBe('paused')
    expect(latest.s!.phase).toBe('answering') // 不收口不恢复主轨
    expect(latest.s!.activeGroupId).toBe(groupId)
    const frozen = latest.s!.answerLineIndex
    await new Promise(r => setTimeout(r, 300))
    expect(latest.s!.answerLineIndex).toBe(frozen) // 挂起不推进
    controller.play()
    await waitFor(() => latest.s!.answerStatus === 'playing')
    await waitFor(() => latest.s!.answerStatus === 'none', 10000) // 播完收口
    expect(latest.s!.activeGroupId).toBeNull()
    controller.destroy()
  }, 15000)

  it('回答暂停中 resumeMainTrack：收口回答，主轨从打断处续播，续播前播过渡句', async () => {
    const { synth: slowSynth, requested } = createSlowSynth()
    const { harness, controller, latest } = await startToPlaying({ synthesizer: slowSynth })
    await playScript(harness, latest)
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1)
    await controller.askText('第一问')
    harness.emit(durableScript('答一句比较长的话术内容方便暂停操作。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering')
    controller.replayAnswer(latest.s!.dialogGroups[0].id)
    await waitFor(() => latest.s!.answerStatus === 'playing')
    controller.pause()
    expect(latest.s!.answerStatus).toBe('paused')
    const resumePos = latest.s!.currentTime
    controller.resumeMainTrack()
    await waitFor(() => latest.s!.answerStatus === 'none')
    expect(latest.s!.activeGroupId).toBeNull()
    expect(latest.s!.dialogGroups[0].done).toBe(true) // 收口但组保留可重播
    await waitFor(() => latest.s!.phase === 'playing', 8000) // 过渡句播完后主轨续播
    expect(requested.map(l => l.lineId)).toContain('aeb-continue-cue')
    expect(requested.find(l => l.lineId === 'aeb-continue-cue')!.text).toBe('好的，我们继续。')
    expect(latest.s!.currentTime).toBeGreaterThanOrEqual(resumePos - 0.3) // 从打断处继续
    controller.destroy()
  }, 15000)

  it('回答暂停中继续追问:收口暂停组并发起新追问', async () => {
    const { synth: slowSynth } = createSlowSynth()
    const { harness, controller, latest } = await startToPlaying({ synthesizer: slowSynth })
    await playScript(harness, latest)
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1)
    await controller.askText('第一问')
    harness.emit(durableScript('答一。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering')
    controller.replayAnswer(latest.s!.dialogGroups[0].id)
    await waitFor(() => latest.s!.answerStatus === 'playing')
    controller.pause()
    expect(latest.s!.answerStatus).toBe('paused')
    const runsBefore = harness.runs.length
    await controller.askText('第二问') // 暂停中发起新追问
    await waitFor(() => latest.s!.dialogGroups.length === 2)
    expect(latest.s!.dialogGroups[0].done).toBe(true) // 暂停组收口(保留可重播)
    expect(latest.s!.activeGroupId).toBe(latest.s!.dialogGroups[1].id)
    expect(harness.runs).toHaveLength(runsBefore + 1) // 新追问 run 已发出
    // 新回答回来正常播报收口,主轨从断点续播
    harness.emit(durableScript('答二。', 'run-3'))
    harness.emit({ runState: 'completed', id: 'done-3' })
    await waitFor(() => latest.s!.answerStatus === 'none', 10000)
    expect(latest.s!.activeGroupId).toBeNull()
    await waitFor(() => latest.s!.phase === 'playing', 8000)
    controller.destroy()
  }, 15000)

  it('主轨已播完(ended)时 resumeMainTrack 从讲解开头重新播', async () => {
    const { synth: slowSynth } = createSlowSynth()
    const { harness, controller, latest } = await startToPlaying({ synthesizer: slowSynth })
    await playScript(harness, latest)
    await waitFor(() => latest.s!.phase === 'ended', 10000) // 主轨播完
    await controller.askText('第一问')
    harness.emit(durableScript('答一句比较长的话术内容方便暂停操作。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest.s!.dialogGroups[0]?.done)
    await waitFor(() => latest.s!.phase !== 'answering') // 收口落 ended
    expect(latest.s!.phase).toBe('ended')
    controller.replayAnswer(latest.s!.dialogGroups[0].id)
    await waitFor(() => latest.s!.answerStatus === 'playing')
    controller.pause()
    controller.resumeMainTrack()
    // 重头播：rewind 后 interpreting → onLineStart 转 playing，时间轴从 0 重新推进
    await waitFor(() => latest.s!.phase === 'playing' || latest.s!.phase === 'interpreting', 8000)
    expect(latest.s!.activeGroupId).toBeNull()
    await waitFor(() => (latest.s?.currentTime || 0) > 0.1, 8000)
    // 重头播：断点在片尾（≈duration），现在时间轴从 0 重新推进（waitFor 轮询间隙已推进，取宽松上界）
    expect(latest.s!.currentTime).toBeLessThan(2)
    controller.destroy()
  }, 20000)
})

describe('ExplainController 播放器可见性（隐藏即停播）', () => {
  /** 记录合成请求行 ID 的快速合成器（媒体秒 ×16 推进） */
  const createCountingSynth = (spoken: string[]): TtsSynthesizer => ({
    synthesizeBatch: async lines => {
      spoken.push(...lines.map(l => l.lineId))
      return new Map(lines.map((l) => {
        const handle = makeSilenceHandle(l.text)
        handle.rate = 16
        return [l.lineId, handle]
      }))
    },
  })

  it('playing 中隐藏 → paused 且合成停止，重开自动续播到 ended', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const spoken: string[] = []
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: createCountingSynth(spoken), configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。第三句。第四句。第五句。第六句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    controller.setVisible(false)
    await waitFor(() => latest!.phase === 'paused')
    // 隐藏后不再有新合成请求（在途预取落缓存后计数冻结）
    await new Promise(r => setTimeout(r, 150))
    const spokenAtHide = spoken.length
    await new Promise(r => setTimeout(r, 150))
    expect(spoken.length).toBe(spokenAtHide)
    controller.setVisible(true)
    await waitFor(() => latest!.phase === 'playing') // 隐藏前在播 → 重开自动续播
    await waitFor(() => latest!.phase === 'ended', 8000)
    controller.destroy()
  })

  it('隐藏期成稿收口不开播、零合成请求；重开不自动播，手动 play 正常', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const spoken: string[] = []
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: createCountingSynth(spoken), configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    controller.setVisible(false) // 隐藏发生在成稿前
    harness.emit(durableScript('第一句。第二句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'paused')
    await new Promise(r => setTimeout(r, 150))
    expect(spoken).toHaveLength(0) // 隐藏期零合成请求（首句也不发）
    controller.setVisible(true)
    await new Promise(r => setTimeout(r, 150))
    expect(latest!.phase).toBe('paused') // 隐藏前未播 → 重开不自动开播
    await controller.play()
    await waitFor(() => latest!.phase === 'ended', 8000)
    expect(spoken.length).toBeGreaterThan(0)
    controller.destroy()
  })

  it('隐藏期追问收口：不做回答合成，主轨停在断点（paused）', async () => {
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const spoken: string[] = []
    const controller = createExplainController({
      explainService: client, repository: harness.repository, synthesizer: createCountingSynth(spoken), configId: '1001',
    })
    let latest: ExplainStateSnapshot | null = null
    controller.subscribe(s => { latest = s })
    controller.setRate(16) // 静音句柄媒体秒 ×16 推进，避免测试超时
    await controller.start()
    harness.emit(durableScript('第一句。第二句。第三句。'))
    harness.emit({ runState: 'completed' })
    await waitFor(() => latest!.phase === 'playing')
    await controller.askText('为什么增长')
    await waitFor(() => latest!.phase === 'answering')
    controller.setVisible(false)
    harness.emit(durableScript('因为新电站放量。', 'run-2'))
    harness.emit({ runState: 'completed', id: 'done-2' })
    await waitFor(() => latest!.answerStatus === 'none')
    expect(spoken.filter(id => id.startsWith('answer-'))).toHaveLength(0) // 隐藏期不做回答合成
    expect(latest!.answerText).toBe('因为新电站放量。') // 回答文本照常可展示
    expect(latest!.phase).toBe('paused') // 主轨不自动恢复，停在断点
    controller.destroy()
  })
})


describe('录音音量回调', () => {
  it('将可选音量回调透传给现有录音器，取消仍仅释放资源', async () => {
    recorderCtl.__set({ supports: true, result: { data: 'demo-audio', format: 'wav' } })
    const harness = createRepositoryHarness()
    const { client } = createServiceMock()
    const controller = createExplainController({ explainService: client, repository: harness.repository, synthesizer: fastSynth, configId: '1001' })
    const onLevel = vi.fn()
    try {
      await controller.startVoiceInput({ onLevel })
      expect(recorderCtl.startRecording).toHaveBeenLastCalledWith({ onLevel })
      await controller.stopVoiceInput({ cancel: true })
      expect(harness.runs).toHaveLength(0)
    } finally {
      controller.destroy()
      recorderCtl.__reset()
    }
  })
})

describe('数据源更新', () => {
  const setup = async () => {
    const harness = createRepositoryHarness()
    const service = createServiceMock()
    const bot = createExplainController({ explainService: service.client, repository: harness.repository, synthesizer: fastSynth, configId: 'test' })
    let state!: ExplainStateSnapshot
    bot.subscribe(s => { state = s })
    await bot.start()
    harness.emit(durableScript('旧数据讲解。'.repeat(30)))
    harness.emit({ runState: 'completed' })
    await waitFor(() => state.phase === 'playing')
    return { bot, harness, service, state: () => state }
  }

  it('立即停旧播报、只接受最后一次取数；暂停状态和历史保留', async () => {
    const t = await setup()
    t.bot.pause()
    let resolveOld!: (md: { mdContext: string }) => void
    const oldSource = new Promise<{ mdContext: string }>(resolve => { resolveOld = resolve })
    const pending = t.bot.refresh({ label: '九月', mdSource: () => oldSource })
    expect(t.state().updating).toBe(true)
    expect(t.state().lines).toHaveLength(0)
    await Promise.resolve()
    await t.bot.refresh({ label: '十月', mdSource: async () => ({ mdContext: '十月新数据' }) })
    resolveOld({ mdContext: '九月旧结果' })
    await pending
    expect(t.service.assemble.mock.calls.map(c => c[1]?.mdContext)).not.toContain('九月旧结果')
    t.harness.emit(durableScript('十月最新讲解。'))
    t.harness.emit({ runState: 'completed' })
    expect(t.state().phase).toBe('paused')
    expect(t.state().updating).toBe(false)
    expect(t.state().lines.map(l => l.text).join('')).toContain('十月最新讲解')
    expect(t.state().contextHistory).toHaveLength(1)
    expect(t.state().sourceLabel).toBe('十月')
    t.bot.destroy()
  })

  it('播放中切换，更新后从新讲解开头播放', async () => {
    const t = await setup()
    await t.bot.refresh({ label: '十一月', mdSource: () => ({ mdContext: '新数据' }) })
    t.harness.emit(durableScript('新讲解。'.repeat(30)))
    t.harness.emit({ runState: 'completed' })
    await waitFor(() => t.state().phase === 'playing')
    expect(t.state().updating).toBe(false)
    expect(t.state().currentTime).toBeLessThan(1)
    t.bot.destroy()
  })

  it('更新失败不会恢复旧内容，重试沿用暂停意图', async () => {
    const t = await setup()
    t.bot.pause()
    let fail = true
    await t.bot.refresh({ label: '十二月', mdSource: async () => {
      if (fail) throw new Error('加载失败')
      return { mdContext: '重试新数据' }
    } })
    expect(t.state().updateFailed).toBe(true)
    expect(t.state().lines).toHaveLength(0)
    fail = false
    await t.bot.retryRefresh()
    t.harness.emit(durableScript('重试生成的新讲解。'))
    t.harness.emit({ runState: 'completed' })
    expect(t.state().phase).toBe('paused')
    expect(t.state().updateFailed).toBe(false)
    expect(t.state().contextHistory).toHaveLength(1)
    t.bot.destroy()
  })

  it('旧订阅迟到的内容不能进入新数据讲解，追问发往更新后的会话', async () => {
    const t = await setup()
    t.bot.pause()
    const oldEvent = vi.mocked(t.harness.repository.subscribeTaskEvents).mock.calls[0][1]
    t.service.assemble.mockResolvedValueOnce({ sessionId: 'new-session', messages: [{ id: 'new', role: 'user', content: '新数据' }] })
    await t.bot.refresh({ label: '新范围', mdSource: () => ({ mdContext: 'new' }) })
    oldEvent(durableScript('过期内容。') as TeldHubTaskEvent)
    expect(t.state().lines).toHaveLength(0)
    t.harness.emit(durableScript('新范围讲解。'))
    t.harness.emit({ runState: 'completed' })
    await t.bot.askText('新范围的订单是多少？')
    expect(vi.mocked(t.harness.repository.startTaskRun).mock.calls.at(-1)?.[0]).toBe('new-session')
    t.bot.destroy()
  })
  it('点击片段会从暂停状态直接定位并播放，更新期间忽略点击', async () => {
    const t = await setup()
    t.bot.pause()
    void t.bot.playLine(2)
    await waitFor(() => t.state().phase === 'playing' && t.state().currentLineIndex === 2)
    expect(t.state().currentTime).toBeGreaterThanOrEqual(t.state().lineStarts[2])
    t.bot.pause()
    await t.bot.refresh({ label: '新数据', mdSource: () => ({ mdContext: 'new' }) })
    await t.bot.playLine(0)
    expect(t.state().phase).toBe('generating')
    expect(t.state().lines).toHaveLength(0)
    t.bot.destroy()
  })

})
