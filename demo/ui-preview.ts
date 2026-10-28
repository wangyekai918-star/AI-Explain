/** Isolated design QA fixture. Never captures audio or sends network requests. */
import { registerAiExplainBot } from '../index'
import type { ExplainController, ExplainStateSnapshot } from '../core/ExplainController'
registerAiExplainBot()
const listeners = new Set<(s: ExplainStateSnapshot) => void>()
let timer: ReturnType<typeof setInterval> | undefined
const snapshot: ExplainStateSnapshot = {
  phase: 'paused', answerStatus: 'none', voiceState: 'idle',
  questionText: '', answerText: '', answerLines: [], answerLineIndex: -1,
  activeGroupId: null, lines: [{ lineId: '1', speaker: 'A', text: '订单量环比增长 8%，近期充电需求有所提升。' }],
  lineStarts: [0], currentLineIndex: 0, currentTime: 4, duration: 22,
  robotConfig: null, isInterruptEnabled: true, error: null,
  dialogGroups: [{ id: 'g1', question: '为什么订单量增长了？', source: 'text', lines: [{ lineId: 'a1', speaker: 'A', text: '可以结合客流、活动和设备可用率进一步分析。当前数据还不能直接说明增长原因。' }], fromDoc: false, done: true, breakpoint: 4 }],
}
const emit = () => listeners.forEach(l => l({ ...snapshot }))
const bot = {
  subscribe(fn: (s: ExplainStateSnapshot) => void) { listeners.add(fn); fn({ ...snapshot }); return () => listeners.delete(fn) },
  loadRobotConfig: async () => {}, start: async () => {},
  setVisible: () => {}, pause: () => {}, play: async () => {}, seekBy: async () => {}, seekTo: async () => {}, setRate: () => {},
  startVoiceInput: async (options?: { onLevel?: (rms: number) => void }) => {
    snapshot.voiceState = 'recording'; emit()
    const start = Date.now()
    timer = setInterval(() => options?.onLevel?.(Math.abs(Math.sin((Date.now() - start) / 370)) * 0.15), 75)
  },
  stopVoiceInput: async () => { clearInterval(timer); snapshot.voiceState = 'idle'; emit() },
  askText: async () => {}, replayAnswer: () => {}, handleControlIntent: () => {}, resumeMainTrack: () => {},
  destroy: () => clearInterval(timer),
} as unknown as ExplainController
const el = document.createElement('teld-ai-explain') as HTMLElement & { bot: ExplainController; open: () => void }
el.bot = bot
el.setAttribute('config-id', 'visual-qa')
el.setAttribute('scenario-name', '经营概览')
el.setAttribute('theme', 'light')
document.body.append(el)
document.querySelector('#open')!.addEventListener('click', () => el.open())
window.addEventListener('pagehide', () => clearInterval(timer))
