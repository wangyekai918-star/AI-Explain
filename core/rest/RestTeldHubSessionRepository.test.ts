import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveBaseUrlFromLocation, RestTeldHubSessionRepository } from './RestTeldHubSessionRepository'

const fetchMock = vi.fn()
const stops: Array<() => void> = []
// 独立组件：基址与令牌全部显式注入，不再 stub TFF/location。
const createRepository = (baseUrl = 'http://as.teld2.xyz') =>
  new RestTeldHubSessionRepository({ baseUrl, getToken: () => 'access-token' })
afterEach(() => stops.splice(0).forEach(stop => stop()))

describe('RestTeldHubSessionRepository', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('creates a session through the injected REST base URL with a bearer token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'session-1' } }), { status: 201 }))

    const task = await createRepository().createTask({
      expertId: 'senior-developer',
      prompt: '定位构建报错',
      model: 'Auto',
      context: [],
    })

    expect(fetchMock).toHaveBeenCalledWith('http://as.teld2.xyz/api/sessions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
      body: JSON.stringify({ agentId: 'senior-developer', title: '定位构建报错' }),
    }))
    expect(task).toMatchObject({ id: 'session-1', expertId: 'senior-developer', state: 'running' })
  })

  it('re-resolves the base URL from mutable options on each request (hubDomain backfill)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { messageId: 'message-1' } }), { status: 202 }))
    const options = { baseUrl: 'http://stale.example', getToken: () => 'access-token' }
    const repository = new RestTeldHubSessionRepository(options)

    // queryRobotConfig 返回 hubDomain 后由 UI 层回填 options.baseUrl，无需重建仓库
    options.baseUrl = 'http://as.teld2.xyz'
    await repository.startTaskRun('session-9', '继续')

    expect(fetchMock).toHaveBeenCalledWith('http://as.teld2.xyz/api/sessions/session-9/runs', expect.anything())
  })

  it('derives the teld9 REST endpoint from the page domain via the optional helper', () => {
    vi.stubGlobal('location', { hostname: 'localhost.teld9.xyz', protocol: 'http:' })
    expect(deriveBaseUrlFromLocation()).toBe('http://as.teld9.xyz')
  })

  it('derives the production REST endpoint and protocol from the page domain via the optional helper', () => {
    vi.stubGlobal('location', { hostname: 'ai.teld.cn', protocol: 'https:' })
    expect(deriveBaseUrlFromLocation()).toBe('https://as.teld.cn')
  })

  it.each(['teld.cn', 'teld.org'])('forces HTTPS for the %s gateway even when the dev page itself uses HTTP', domain => {
    vi.stubGlobal('location', { hostname: `localhost.ai.${domain}`, protocol: 'http:' })
    expect(deriveBaseUrlFromLocation()).toBe(`https://as.${domain}`)
  })

  it('falls back to __domain when the hostname has fewer than two labels', () => {
    vi.stubGlobal('location', { hostname: 'localhost', protocol: 'http:' })
    ;(globalThis as any).__domain = '.teld9.xyz'
    try { expect(deriveBaseUrlFromLocation()).toBe('http://as.teld9.xyz') } finally { delete (globalThis as any).__domain }
  })

  it('starts an AG-UI run with a thread-bound user message and interrupts only the current run', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { messageId: 'message-1' } }), { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const repository = createRepository()

    const events = await repository.startTaskRun('session-1', '继续分析')
    const interruptedTask = await repository.interruptTask('session-1')

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://as.teld2.xyz/api/sessions/session-1/runs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer access-token', 'Idempotency-Key': expect.any(String) }),
      body: expect.stringMatching(/^\{"threadId":"session-1","runId":"run-.+","messages":\[\{"id":".+","role":"user","content":"继续分析"}\]\}$/),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://as.teld2.xyz/api/sessions/session-1/interrupt', expect.objectContaining({ method: 'POST' }))
    // POST /runs 只表示已经入队；用户和助手消息都以 SSE 为唯一来源，不能本地补一条假消息。
    expect(events).toEqual([])
    expect(interruptedTask).toMatchObject({ id: 'session-1', state: 'running' })
  })

  it('forwards assembleExplain messages verbatim as a multi-message run', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { messageId: 'message-1' } }), { status: 202 }))
    const messages = [
      { id: 'sys-1', role: 'system', content: '你是经营数据讲解助手……' },
      { id: 'user-1', role: 'user', content: '# 2026Q1 销量分析' },
    ]

    await createRepository('https://as.teld.cn').startTaskRunWithMessages('ses_8f3c', messages, 'run-key-1')

    expect(fetchMock).toHaveBeenCalledWith('https://as.teld.cn/api/sessions/ses_8f3c/runs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Idempotency-Key': 'run-key-1' }),
    }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      threadId: 'ses_8f3c',
      runId: 'run-run-key-1',
      messages,
    })
  })

  it('sends the successful preparation context as the first context string', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { messageId: 'message-1' } }), { status: 202 }))
    const context = {
      businessScope: { objects: [{ objectType: 'STATION', objectId: 'station-1', objectName: '测试站' }] },
      scenario: 'SCOPE_METRIC_QUERY',
    }

    await createRepository().startTaskRun('session-1', '查询充电量', 'message-1', JSON.stringify(context))

    const options = fetchMock.mock.calls[0][1]
    expect(JSON.parse(options.body)).toMatchObject({
      threadId: 'session-1',
      messages: [{ id: 'message-1', role: 'user', content: '查询充电量' }],
      context: [JSON.stringify(context)],
    })
  })

  it('sends the selected company or area as the second AgentScope context string', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { messageId: 'message-1' } }), { status: 202 }))
    const preparedContext = JSON.stringify({ scenario: 'SCOPE_METRIC_QUERY' })
    const scopeContext = JSON.stringify({ companyId: '1112222', areaId: '' })

    await createRepository().startTaskRun('session-1', '查询充电量', 'message-1', preparedContext, scopeContext)

    const options = fetchMock.mock.calls[0][1]
    expect(JSON.parse(options.body)).toMatchObject({
      context: [preparedContext, scopeContext],
    })
  })

  it('keeps a user message and assistant tokens separate when they share a backend messageId', async () => {
    const encoder = new TextEncoder()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start (controller) {
        controller.enqueue(encoder.encode([
          'id: d-1\nevent: message\ndata: {"id":"d-1","messageId":"message-1","payload":{"role":"user","text":"用户问题","clientMessageId":"web-message-1"}}\n\n',
          'id: s-2\nevent: run.started\ndata: {"id":"s-2","messageId":"message-1","payload":null}\n\n',
          'id: t-1\nevent: token\ndata: {"id":"t-1","messageId":"message-1","payload":"助手回复"}\n\n',
          'id: s-3\nevent: message.failed\ndata: {"id":"s-3","type":"message.failed","messageId":"message-1","payload":{"errorCode":"QUEUE_TIMEOUT"}}\n\n',
        ].join('')))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const onEvent = vi.fn()

    stops.push(createRepository().subscribeTaskEvents('session-1', onEvent))
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ id: 'assistant:message-1', taskId: 'session-1', type: 'agent.message', text: '助手回复', streaming: true, sourceMessageId: 'message-1' }))
    expect(onEvent).toHaveBeenCalledWith({ id: 'user:web-message-1', taskId: 'session-1', type: 'user.message', text: '用户问题', streaming: false, runMessageId: 'message-1', sourceMessageId: 'message-1', clientMessageId: 'web-message-1' })
    expect(onEvent).toHaveBeenCalledWith({ id: 'run:message-1:started', taskId: 'session-1', type: 'session.status_running', text: '', runState: 'started', sourceMessageId: 'message-1' })
    expect(onEvent).toHaveBeenCalledWith({ id: 'run:message-1:failed', taskId: 'session-1', type: 'session.status_idle', text: 'QUEUE_TIMEOUT', runState: 'failed', sourceMessageId: 'message-1' })

    expect(fetchMock).toHaveBeenCalledWith('http://as.teld2.xyz/api/sessions/session-1/events', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }))
  })

  it('parses wrapped AG-UI thought, tool, and text events immediately instead of waiting for a final message', async () => {
    const encoder = new TextEncoder()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start (controller) {
        controller.enqueue(encoder.encode([
          'id: a-1\nevent: agui\ndata: {"id":"a-1","type":"agui","messageId":"message-2","payload":"{\\"type\\":\\"THINKING_TEXT_MESSAGE_CONTENT\\",\\"messageId\\":\\"message-2\\",\\"delta\\":\\"正在分析数据\\"}"}\n\n',
          'id: a-2\nevent: agui\ndata: {"id":"a-2","type":"agui","messageId":"message-2","payload":"{\\"type\\":\\"TOOL_CALL_START\\",\\"messageId\\":\\"message-2\\",\\"toolCallId\\":\\"call-1\\",\\"toolName\\":\\"query_data\\"}"}\n\n',
          'id: a-3\nevent: agui\ndata: {"id":"a-3","type":"agui","messageId":"message-2","payload":"{\\"type\\":\\"TEXT_MESSAGE_CONTENT\\",\\"messageId\\":\\"message-2\\",\\"role\\":\\"assistant\\",\\"delta\\":\\"这是实时回复\\"}"}\n\n',
        ].join('')))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const onEvent = vi.fn()

    stops.push(createRepository().subscribeTaskEvents('session-1', onEvent))

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'assistant:message-2', type: 'agent.message', text: '这是实时回复', streaming: true, runMessageId: 'message-2' })))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.activity', activityKind: 'reasoning', activityLabel: '思考过程', text: '正在分析数据', runMessageId: 'message-2' }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.activity', activityKind: 'tool', activityLabel: '工具调用：query_data', runMessageId: 'message-2' }))
  })

  it('forwards cumulative token usage from AG-UI custom events as the only usage event', async () => {
    const encoder = new TextEncoder()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start (controller) {
        controller.enqueue(encoder.encode('id: usage-1\nevent: agui\ndata: {"id":"usage-1","type":"agui","messageId":"message-3","payload":{"type":"CUSTOM","name":"token_usage","value":{"delta":{"totalTokens":1152},"cumulative":{"inputTokens":4096,"outputTokens":512,"cachedTokens":3072,"totalTokens":4608,"time":3.75}}}}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const onEvent = vi.fn()

    stops.push(createRepository().subscribeTaskEvents('session-1', onEvent))

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'token.usage',
      runMessageId: 'message-3',
      tokenUsage: { inputTokens: 4096, outputTokens: 512, cachedTokens: 3072, totalTokens: 4608, time: 3.75 },
    })))
  })

  it('notifies the caller after the event stream response is connected', async () => {
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start (controller) { controller.close() } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const onConnected = vi.fn()

    stops.push(createRepository().subscribeTaskEvents('session-1', vi.fn(), undefined, onConnected))

    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
  })

  it('keeps the final message server timestamp without taking the later run completion time', () => {
    const onEvent = vi.fn()
    const repository = createRepository()
    ;(repository as any).parseFrame('session', 'event: message\ndata: '+JSON.stringify({ type: 'message', messageId: 'server', timestamp: '2026-10-15T06:08:04.383434031Z', payload: { role: 'assistant', text: '回复' } }), onEvent)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.message', timestamp: '2026-10-15T06:08:04.383434031Z' }))
  })

})
