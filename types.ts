export type TaskState = 'running' | 'paused' | 'waiting_confirmation' | 'completed'

export type TaskPlanStatus = 'pending' | 'running' | 'completed'

export interface TaskContextItem {
  id: string
  type: 'file' | 'agent' | 'skill' | 'project' | 'library'
  label: string
}

export interface CreateTaskInput {
  expertId: string
  prompt: string
  model: string
  context: TaskContextItem[]
}

export interface TeldHubTaskPlanStep {
  name: string
  status: TaskPlanStatus
}

export interface TeldHubTask {
  id: string
  expertId: string
  prompt: string
  model: string
  context: TaskContextItem[]
  state: TaskState
  plan: TeldHubTaskPlanStep[]
}

export type TeldHubTaskEventType = 'user.message' | 'agent.message' | 'agent.activity' | 'token.usage' | 'session.status_running' | 'session.status_idle' | 'session.error'

/** AG-UI CUSTOM/token_usage 事件中 value.cumulative 的官方累计口径。 */
export interface TeldHubTokenUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  time: number
}

export type TeldHubInterruptResult = TeldHubTask & { interruptRequested?: boolean; interruptMessageId?: string }

export interface TeldHubTaskEvent {
  id: string
  taskId: string
  type: TeldHubTaskEventType
  text: string
  streaming?: boolean
  /** 消息事件的服务端时间；缺失时不以本地时钟补造。 */
  timestamp?: string
  /** SSE 外层关联 ID；页面只能按明确身份归并，不能套入最新追问。 */
  sourceMessageId?: string
  clientMessageId?: string
  terminalState?: 'completed' | 'failed' | 'interrupted'
  runState?: 'preparing' | 'need_input' | 'queued' | 'started' | 'finalizing' | 'interrupting' | 'interrupted' | 'completed' | 'failed'
  /** 该事件所属的用户消息，用于将 AG-UI 过程片段归并到同一轮回答。 */
  runMessageId?: string
  /** AG-UI 中不属于最终回答正文的运行片段，例如思考和工具调用。 */
  activityKind?: 'reasoning' | 'tool' | 'progress'
  activityLabel?: string
  activityExpanded?: boolean
  /** 仅由 AG-UI CUSTOM/token_usage 的 cumulative 字段提供。 */
  tokenUsage?: TeldHubTokenUsage
}

/** POST /runs 的 messages[] 元素；assembleExplain 出参即为该结构的多消息数组。 */
export interface WorkHubRunMessage {
  id: string
  role: string
  content: string
}

/* ══════════ 讲解管理服务（对外接口文档.md）出参实体 ══════════ */

export interface RobotSize {
  width: number
  height: number
}

export interface RobotSet {
  backgroundImage?: string
  /** 组件不再消费（主题由 theme 属性 / themeColor 判定，见 ui/themes.ts themeFromColor）；字段保留透传。 */
  backgroundColor?: string
  /** 主题 key 来源：未显式传 theme 属性时按其亮度判定 dark/light 预制。 */
  themeColor?: string
  robotImage?: string
  robotSize?: RobotSize
  /** 机器人展示位置（上下-左右，如 bottom-right）。 */
  position?: string
  /** 扩展配置（JSON 对象，无则 null）；已约定字段：avatarDraggable（浮动图标是否可拖动，true/'true' 均认，attribute avatar-draggable 显式传值优先）、continueCue（回到主轨续播前的语音过渡句文案，string，空串关闭，缺省「好的，我们继续。」）。 */
  ext?: Record<string, unknown> | null
}

export interface ExpertItem {
  code: string
  name: string
  isDefault?: boolean
}

export interface SkillItem {
  code: string
  name: string
  isDefault?: boolean
}

export interface RobotConfig {
  robotSet?: RobotSet
  /** 是否允许打断（追问入口显隐由它决定）。 */
  isInterrupt?: boolean
  interruptSet?: { experts?: ExpertItem[], skills?: SkillItem[] }
  /** WorkHub 网关基址：宿主未显式传 baseUrl 时的缺省值。 */
  hubDomain?: string
  /** 语音/解读人配置：字幕角色名按 role 取 displayName，追问音色按 answerQuestion 选角色。 */
  voiceSetting?: VoiceSetting
}

/** 语音/解读人配置（queryRobotConfig.voiceSetting）。 */
export interface VoiceSetting {
  /** 音色方案编号（语义待后端明确，暂不消费，仅透传保留）。 */
  roleDivisionId?: string
  voices?: VoiceSettingVoice[]
}

export interface VoiceSettingVoice {
  /** 讲解角色（A/B）。 */
  role: string
  /** 解读人展示名（字幕/界面按 role 取用）。 */
  displayName: string
  /** 该角色音色是否用于追问回答播报。 */
  answerQuestion?: boolean
}

export interface ExplainMessage {
  id: string
  role: string
  content: string
}

export interface ExplainAssembleResult {
  sessionId: string
  /** 待发送消息（仅业务消息，role=system 的提示词由适配层剥离），末条为 role=user。 */
  messages: ExplainMessage[]
}

export interface SpeechRecognitionResult {
  text: string
  durationMs: number
}

/** 讲解管理服务业务错误码（TResponse.errcode）。 */
export type ExplainServiceErrorCode = '1001' | '1002' | '1003' | '1004' | string
