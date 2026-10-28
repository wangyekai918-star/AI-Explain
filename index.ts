/**
 * AI 讲解（语音播报）独立组件 —— 对外入口
 *
 * 两种用法：
 * 1. ES import（Vite 项目）：
 *    import { registerAiExplainBot } from '@/ai-explain-bot'
 *    registerAiExplainBot()                      // 注册 <teld-ai-explain>
 *    // 或 headless 直用：
 *    const bot = createExplainController({ ... })
 *
 * 2. <script src>（IIFE 产物，external 版需宿主已有全局 Vue）：
 *    <script src="teld-ai-explain.iife.js"></script>
 *    <teld-ai-explain config-id="1001" theme="dark"></teld-ai-explain>
 */
export { createExplainController } from './core/ExplainController'
export type { ExplainController, ExplainControllerOptions, ExplainStateSnapshot, ExplainPhase, ExplainErrorKind, DataSourceUpdate, ExplainContextHistory } from './core/ExplainController'
export { ExplainServiceClient, ExplainServiceError, createExplainServiceClient } from './core/explainServiceClient'
export type { ExplainServiceClientOptions, ExplainTransport } from './core/explainServiceClient'
export { RestTeldHubSessionRepository, deriveBaseUrlFromLocation } from './core/rest/RestTeldHubSessionRepository'
export type { RestTeldHubSessionRepositoryOptions } from './core/rest/RestTeldHubSessionRepository'
export {
  createBatchSynthesizer,
  createBrowserSynthesizer,
  createCompositeSynthesizer,
  makeAudioHandle,
  makeSilenceHandle,
  estimateLineSeconds,
  SPEAKER_META,
} from './core/ttsEngine'
export type { TtsSynthesizer, TtsLine, AudioHandle, SynthesizeBatchOptions } from './core/ttsEngine'
export { startRecording, supportsRecording } from './core/recorder'
export { ScriptAssembler } from './core/scriptAssembler'
export { DialoguePlayer } from './core/dialoguePlayer'
export { registerAiExplainBot, TeldAiExplainElement } from './ui/customElement'
export { themeTokens, formatClock } from './ui/themes'
export type { ExplainTheme } from './ui/themes'
export * from './types'
