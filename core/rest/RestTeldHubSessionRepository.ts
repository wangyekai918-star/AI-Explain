import type { CreateTaskInput, TeldHubTask, TeldHubTaskEvent, TeldHubInterruptResult, WorkHubRunMessage } from '../../types'
import { restRequest, TeldHubRestError, waitWithSignal } from './restTransport'
import { defaultStreamStorage, subscribeSessionStream, type StreamStorage } from './sessionEventStream'

type RestResponse = Record<string, unknown> & { data?: Record<string, unknown>, message?: string }
type WireRecord = Record<string, unknown>

export interface RestTeldHubSessionRepositoryOptions {
  /** WorkHub REST 网关基址（如 https://as.teld.cn）。独立组件不隐式读取 location。 */
  baseUrl: string
  /** 访问令牌提供者，每次请求前同步调用。宿主自行决定来源（Cookie/localStorage 等）。 */
  getToken: () => string
  /** SSE 游标存储；默认 sessionStorage，不可用时退化为内存。 */
  storage?: StreamStorage
}

/** 原 teldhub 页面的域名推导逻辑；作为可选工具保留，宿主自行决定是否复用。 */
export function deriveBaseUrlFromLocation (location: { hostname: string, protocol: string } = globalThis.location): string {
  const labels = location.hostname.split('.').filter(Boolean)
  const rootDomain = labels.length >= 2
    ? labels.slice(-2).join('.')
    : String((globalThis as any).__domain || '').replace(/^\./, '')
  // 生产网关的 HTTP 会 301 到 HTTPS，OPTIONS 预检不能跟随重定向。
  // 本地 HTTP 页面访问生产域时也必须直接用 HTTPS；测试域沿用页面协议。
  const serviceProtocol = ['teld.cn', 'teld.org'].includes(rootDomain) ? 'https:' : location.protocol === 'https:' ? 'https:' : 'http:'
  return `${serviceProtocol}//as.${rootDomain}`
}

export class RestTeldHubSessionRepository {
  private readonly tasks = new Map<string, TeldHubTask>()
  private readonly subscriptions = new Map<string, () => void>()
  private readonly runRequests = new Map<string, Set<AbortController>>()

  constructor (private readonly options: RestTeldHubSessionRepositoryOptions) {}

  cancelTaskRequests (taskId: string): void {
    this.runRequests.get(taskId)?.forEach(controller => controller.abort())
    this.runRequests.delete(taskId)
  }

  async createTask (input: CreateTaskInput): Promise<TeldHubTask> {
    const { response, payload } = await this.request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId: input.expertId, title: input.prompt }),
    })
    const sessionId = this.getSessionId(payload, response.headers.get('Location'))
    if (!sessionId) throw new Error('创建会话成功但响应未包含 sessionId')
    const data = payload.data || payload
    const task: TeldHubTask = {
      id: sessionId,
      expertId: String(data.agentId || data.AgentId || input.expertId),
      prompt: String(data.title || data.Title || input.prompt),
      model: input.model,
      context: input.context,
      state: this.toTaskState(String(data.status || data.Status || 'ACTIVE')),
      plan: [],
    }
    this.tasks.set(sessionId, task)
    return task
  }

  async startTaskRun (taskId: string, text: string, clientMessageId: string = this.newMessageId(), preparedContext?: string, frameworkScopeContext?: string): Promise<TeldHubTaskEvent[]> {
    const context = frameworkScopeContext === undefined
      ? (preparedContext ? [preparedContext] : undefined)
      : [preparedContext || '', frameworkScopeContext]
    return this.startTaskRunWithMessages(taskId, [{ id: clientMessageId, role: 'user', content: text }], clientMessageId, context)
  }

  /**
   * 发送一轮 run；messages 支持多消息（assembleExplain 出参的 system+user 数组
   * 原样转发）。threadId/runId/Idempotency-Key/SSE 语义与单消息形态完全一致。
   */
  async startTaskRunWithMessages (taskId: string, messages: WorkHubRunMessage[], clientMessageId: string = this.newMessageId(), context?: string[]): Promise<TeldHubTaskEvent[]> {
    const controller = new AbortController()
    const requests = this.runRequests.get(taskId) || new Set<AbortController>()
    requests.add(controller)
    this.runRequests.set(taskId, requests)
    try {
      const init: RequestInit = {
        method: 'POST', signal: controller.signal,
        headers: { 'Idempotency-Key': clientMessageId },
        body: JSON.stringify({
          threadId: taskId,
          runId: `run-${clientMessageId}`,
          messages,
          ...(context?.length ? { context } : {}),
        }),
      }
      const path = `/api/sessions/${encodeURIComponent(taskId)}/runs`
      let result
      try { result = await this.request(path, init) } catch (error) {
        // 只有明确未受理的限流响应才自动重试，网络超时不能重发不确定的 POST。
        if (!(error instanceof TeldHubRestError) || error.status !== 429) throw error
        await waitWithSignal(error.retryAfterMs, controller.signal)
        result = await this.request(path, init)
      }
      const { response, payload } = result
      const data = payload.data || payload
      // AG-UI 的 POST /runs 仅表示本轮已进入服务端；消息展示必须以 SSE 的 durable
      // `message` / 流式 `token` 事件为准，不能在前端本地伪造用户或助手消息。
      // 幂等重放且已完成不会再发 SSE，直接把本轮状态收口，避免输入框永远处于执行中。
      if (response.status === 200 && Boolean(data.replayed) && ['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(String(data.status).toUpperCase())) {
        const state = String(data.status).toLowerCase() as 'completed' | 'failed' | 'interrupted'
        const messageId = String(data.resultEntryId || data.messageId || clientMessageId)
        return [{ id: `run:${messageId}:${state}`, taskId, type: 'session.status_idle', text: '', runState: state, runMessageId: clientMessageId }]
      }
      return []
    } finally {
      requests.delete(controller)
      if (this.runRequests.get(taskId) === requests && !requests.size) this.runRequests.delete(taskId)
    }
  }

  async interruptTask (taskId: string): Promise<TeldHubInterruptResult> {
    const { response, payload } = await this.request(`/api/sessions/${encodeURIComponent(taskId)}/interrupt`, {
      method: 'POST', body: JSON.stringify({ reason: 'USER_REQUESTED' }),
    })
    const data = payload.data || payload
    const task = this.tasks.get(taskId) || { id: taskId, expertId: '', prompt: '', model: 'Auto', context: [], state: 'running' as const, plan: [] }
    this.tasks.set(taskId, task)
    return { ...task, interruptRequested: response.status === 204 || data.requested !== false, interruptMessageId: typeof data.messageId === 'string' ? data.messageId : undefined }
  }

  subscribeTaskEvents (taskId: string, onEvent: (event: TeldHubTaskEvent) => void, onError?: (error: Error) => void, onConnected?: () => void): () => void {
    this.subscriptions.get(taskId)?.()
    // Token 指纹只隔离缓存身份，不把原始令牌写入存储或 URL。
    let fingerprint = 2166136261
    for (const char of this.token()) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619)
    const stop = subscribeSessionStream({
      cursorKey: `teldhub:sse:${this.baseUrl()}:${fingerprint >>> 0}:${taskId}`,
      storage: this.options.storage || defaultStreamStorage(),
      open: async (signal, cursor) => {
        const { response } = await this.request(`/api/sessions/${encodeURIComponent(taskId)}/events`, {
          method: 'GET', signal,
          headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
        }, true)
        return response
      },
      onFrame: frame => this.parseFrame(taskId, frame, onEvent), onError, onConnected,
    })
    const dispose = () => {
      stop()
      if (this.subscriptions.get(taskId) === dispose) this.subscriptions.delete(taskId)
    }
    this.subscriptions.set(taskId, dispose)
    return dispose
  }

  private parseFrame (taskId: string, frame: string, onEvent: (event: TeldHubTaskEvent) => void): void {
    const eventName = frame.match(/^event:\s*(.+)$/m)?.[1] || 'message'
    const frameId = frame.match(/^id:\s*(.+)$/m)?.[1]
    const rawData = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (!eventName || !rawData) return
    let data: WireRecord
    try { data = JSON.parse(rawData) as WireRecord } catch { return }
    const eventType = String(data.type || eventName)
    const messageId = String(data.messageId || data.id || frameId || `${taskId}-${Date.now()}`)
    const emit = (event: TeldHubTaskEvent) => {
      const payload = this.toRecord(data.payload)
      const clientMessageId = payload.clientMessageId
      const terminalState = payload.status === 'interrupted' || payload.interrupted === true ? 'interrupted' : payload.status === 'failed' ? 'failed' : undefined
      onEvent({ ...event, ...(eventType === 'message' && typeof data.timestamp === 'string' ? { timestamp: data.timestamp } : {}), sourceMessageId: messageId, ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}), ...(event.type === 'agent.message' && !event.streaming && terminalState ? { terminalState } : {}) })
    }
    if (eventType.toLowerCase() === 'agui') {
      this.parseAguiEvent(taskId, messageId, data.payload, emit)
      return
    }
    const payload = this.toRecord(data.payload)
    if (eventType === 'message' || eventType === 'token') {
      const text = this.getEventText(payload)
      const isUser = eventType === 'message' && String(payload.role || '').toLowerCase() === 'user'
      // 本地已用 clientMessageId 乐观渲染过用户消息；SSE 的服务端 messageId 不同，必须用 clientMessageId 合并，不能再插入一条。
      const eventMessageId = isUser ? String(payload.clientMessageId || messageId) : messageId
      if (text || (!isUser && eventType === 'message')) emit({ id: `${isUser ? 'user' : 'assistant'}:${eventMessageId}`, taskId, type: isUser ? 'user.message' : 'agent.message', text, streaming: eventType === 'token', ...(isUser ? { runMessageId: messageId } : {}) })
    } else if (eventType === 'error' || eventType === 'message.failed') {
      // AG-UI 失败同样属于本轮 run，不能脱离回复单独弹出一张无关联的错误卡片。
      emit({ id: `run:${messageId}:failed`, taskId, type: 'session.status_idle', text: String(payload.errorCode || payload.message || '会话执行失败'), runState: 'failed' })
    } else if (eventType === 'run.queued') {
      emit({ id: `run:${messageId}:queued`, taskId, type: 'session.status_running', text: '', runState: 'queued' })
    } else if (eventType === 'run.started') {
      emit({ id: `run:${messageId}:started`, taskId, type: 'session.status_running', text: '', runState: 'started' })
    } else if (eventType === 'run.interrupt') {
      emit({ id: `run:${messageId}:interrupting`, taskId, type: 'session.status_running', text: '中断已受理，正在等待执行停止', runState: 'interrupting', runMessageId: messageId })
    } else if (eventType === 'run.interrupted') {
      emit({ id: `run:${messageId}:interrupted`, taskId, type: 'session.status_idle', text: '', runState: 'interrupted', runMessageId: messageId })
    } else if (eventType === 'stream.degraded') {
      emit({ id: `stream:${messageId}:degraded`, taskId, type: 'session.error', text: '实时链路已降级，部分执行过程可能缺失，请重新同步' })
    } else if (eventType === 'run.progress' && payload.status === 'running' && ['preparing', 'executing', 'finalizing'].includes(String(payload.phase))) {
      emit({ id: `run:${messageId}:finalizing`, taskId, type: 'session.status_running', text: payload.phase === 'finalizing' ? '执行已结束，正在保存结果' : payload.phase === 'preparing' ? '正在准备执行环境' : '正在执行', runState: payload.phase === 'finalizing' ? 'finalizing' : 'started', runMessageId: messageId })
    } else if (eventType === 'run.completed') {
      emit({ id: `run:${messageId}:completed`, taskId, type: 'session.status_idle', text: '', runState: 'completed' })
    }
  }

  /**
   * 网关把 AG-UI 原始事件包装成 `event: agui`。这里不等待最终 durable message，
   * 而是立即拆出标准 AG-UI 的正文增量、思考、工具调用和 run 状态。
   */
  private parseAguiEvent (taskId: string, fallbackMessageId: string, rawPayload: unknown, onEvent: (event: TeldHubTaskEvent) => void): void {
    const agui = this.unwrapAguiPayload(rawPayload)
    if (!agui) return
    const aguiType = String(agui.type || agui.event || '').toUpperCase()
    if (!aguiType) return
    const message = this.toRecord(agui.message)
    // AG-UI 内层 messageId 常常是“助手输出消息 ID”，而外层 messageId 才是本轮
    // 用户输入的关联 ID。所有过程和正文必须按外层 ID 归并，不能拆成多张专家卡。
    const messageId = fallbackMessageId || String(agui.messageId || agui.id || message.id || `${taskId}-${Date.now()}`)
    const role = String(agui.role || message.role || '').toLowerCase()
    const text = this.getEventText(agui)

    // 模型网关在每次调用完成后发送 AG-UI CUSTOM/token_usage；只有其 cumulative
    // 是本 run 的官方累计口径，不能从消息或 run 状态推断 Token 用量。
    if (aguiType === 'CUSTOM' && String(agui.name || '') === 'token_usage') {
      const cumulative = this.toRecord(this.toRecord(agui.value).cumulative)
      const totalTokens = Number(cumulative.totalTokens)
      if (!Number.isFinite(totalTokens) || totalTokens < 0) return
      const nonNegativeNumber = (value: unknown) => {
        const numberValue = Number(value)
        return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0
      }
      onEvent({
        id: `token-usage:${messageId}`,
        taskId,
        type: 'token.usage',
        text: '',
        runMessageId: messageId,
        tokenUsage: {
          inputTokens: nonNegativeNumber(cumulative.inputTokens),
          outputTokens: nonNegativeNumber(cumulative.outputTokens),
          cachedTokens: nonNegativeNumber(cumulative.cachedTokens),
          totalTokens,
          time: nonNegativeNumber(cumulative.time),
        },
      })
      return
    }

    if (aguiType.includes('RUN_')) {
      if (aguiType.includes('QUEUED')) onEvent({ id: `run:${messageId}:queued`, taskId, type: 'session.status_running', text: '', runState: 'queued', runMessageId: messageId })
      else if (aguiType.includes('START')) onEvent({ id: `run:${messageId}:started`, taskId, type: 'session.status_running', text: '', runState: 'started', runMessageId: messageId })
      else if (aguiType.includes('ERROR') || aguiType.includes('FAIL')) onEvent({ id: `run:${messageId}:failed`, taskId, type: 'session.status_idle', text: text || '会话执行失败', runState: 'failed', runMessageId: messageId })
      else if (aguiType.includes('FINISH') || aguiType.includes('COMPLETE')) onEvent({ id: `run:${messageId}:completed`, taskId, type: 'session.status_running', text: '执行已结束，正在保存结果', runState: 'finalizing', runMessageId: messageId })
      return
    }

    if (aguiType.includes('TEXT_MESSAGE') && !aguiType.includes('THINK') && !aguiType.includes('REASON')) {
      if (aguiType.includes('CONTENT') || aguiType.includes('DELTA') || aguiType.includes('CHUNK')) {
        if (text) onEvent({ id: `${role === 'user' ? 'user' : 'assistant'}:${messageId}`, taskId, type: role === 'user' ? 'user.message' : 'agent.message', text, streaming: true, runMessageId: messageId })
      } else if (aguiType.includes('START')) {
        onEvent({ id: `run:${messageId}:started`, taskId, type: 'session.status_running', text: '', runState: 'started', runMessageId: messageId })
      }
      return
    }

    const isReasoning = aguiType.includes('THINK') || aguiType.includes('REASON')
    const isTool = aguiType.includes('TOOL')
    const isProgress = aguiType.includes('STEP') || aguiType.includes('PLAN') || aguiType.includes('ACTIVITY')
    if (!isReasoning && !isTool && !isProgress) return

    const toolCall = this.toRecord(agui.toolCall || agui.tool_call)
    const tool = this.toRecord(agui.tool || agui.function)
    const toolName = String(agui.toolCallName || agui.toolName || agui.tool_name || agui.name || toolCall.name || toolCall.toolName || toolCall.tool_name || tool.name || tool.tool_name || '')
    const activityKind = isReasoning ? 'reasoning' : isTool ? 'tool' : 'progress'
    const activityKey = String(agui.toolCallId || agui.tool_call_id || agui.callId || toolCall.id || agui.stepId || activityKind)
    const label = isReasoning ? '思考过程' : isTool ? `工具调用：${toolName || '未命名工具'}` : '执行过程'
    let activityText = text
    if (isTool) {
      // AG-UI 标准工具事件：START 只带名称，ARGS 通过 delta 逐段传参，RESULT 再单独回传结果。
      if (aguiType.includes('START') && !activityText) activityText = toolName ? `工具名称：${toolName}\n调用 ID：${activityKey}` : `调用 ID：${activityKey}\n原始事件：${JSON.stringify(agui, null, 2)}`
      else if (aguiType.includes('ARGS') && activityText) activityText = `\n参数：${activityText}`
      else if (aguiType.includes('RESULT') && activityText) activityText = `\n结果：${activityText}`
      else if (aguiType.includes('END') && !activityText) activityText = '\n状态：调用完成'
    }
    onEvent({ id: `activity:${messageId}:${activityKey}`, taskId, type: 'agent.activity', text: activityText, streaming: true, activityKind, activityLabel: label, runMessageId: messageId })
  }

  private unwrapAguiPayload (payload: unknown): WireRecord | undefined {
    const first = this.toRecord(payload)
    if (!Object.keys(first).length) return undefined
    if (first.type || first.event) return this.flattenAguiEnvelope(first)
    for (const key of ['event', 'data', 'payload']) {
      const candidate = this.toRecord(first[key])
      if (candidate.type || candidate.event) return this.flattenAguiEnvelope(candidate)
    }
    return first
  }

  private flattenAguiEnvelope (event: WireRecord): WireRecord {
    // 部分网关转发为 { event: 'TOOL_CALL_START', data: {...} }；先拍平才能拿到工具名和参数。
    const data = this.toRecord(event.data)
    const payload = this.toRecord(event.payload)
    return { ...event, ...data, ...payload, type: event.type || event.event || data.type || payload.type }
  }

  private toRecord (value: unknown): WireRecord {
    if (typeof value === 'string') {
      try { return JSON.parse(value) as WireRecord } catch { return { text: value } }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as WireRecord : {}
  }

  private getEventText (value: WireRecord): string {
    const message = this.toRecord(value.message)
    const payload = this.toRecord(value.payload)
    const data = this.toRecord(value.data)
    const content = value.delta ?? value.text ?? value.content ?? value.arguments ?? value.args ?? value.input ?? value.parameters ?? value.toolCallArgs ?? value.tool_call_args ?? value.result ?? value.output ?? message.content ?? payload.delta ?? payload.text ?? payload.content ?? payload.arguments ?? payload.result ?? data.delta ?? data.text ?? data.content ?? data.arguments ?? data.result ?? ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : String(this.toRecord(part).text || this.toRecord(part).content || '')).join('')
    if (content == null) return ''
    if (typeof content === 'object') {
      try { return JSON.stringify(content, null, 2) } catch { return String(content) }
    }
    return String(content)
  }

  private async request (path: string, init: RequestInit, stream = false): Promise<{ response: Response, payload: RestResponse }> {
    return restRequest(`${this.baseUrl()}${path}`, this.token(), init, stream)
  }

  private baseUrl (): string {
    // 独立组件：基址由宿主显式注入，不再从 location 隐式推导（
    // deriveBaseUrlFromLocation 作为可选工具保留给需要的宿主）。
    return this.options.baseUrl.replace(/\/+$/, '')
  }
  private token (): string { return this.options.getToken() || '' }
  /** 兜底消息 ID：优先 crypto.randomUUID，老运行时退化为时间戳+随机段。 */
  private newMessageId (): string {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
  private toTaskState (status: string): TeldHubTask['state'] { return status === 'ACTIVE' || status === 'QUEUED' || status === 'ACCEPTED' || status === 'EXECUTING' ? 'running' : 'completed' }
  private getSessionId (payload: RestResponse, location: string | null): string {
    const data = payload.data || payload
    return String(data.id || data.Id || data.sessionId || data.SessionId || location?.split('/').filter(Boolean).pop() || '')
  }
}
