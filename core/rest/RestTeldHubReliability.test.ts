import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestTeldHubSessionRepository } from './RestTeldHubSessionRepository'

const fetchMock = vi.fn()
const stops: Array<() => void> = []
const input = { expertId: 'agent', prompt: '问题', model: 'Auto', context: [] }
// 独立组件：基址与令牌显式注入；可靠性用例不关心具体域名，统一用生产形态基址。
const createRepository = (getToken: () => string = () => 'access-token') =>
  new RestTeldHubSessionRepository({ baseUrl: 'https://as.teld.cn', getToken })
const encode = (text: string) => new TextEncoder().encode(text)
const frame = (id: string, delta = '正文') => `id: ${id}\nevent: agui\ndata: ${JSON.stringify({ type: 'agui', messageId: 'run-1', payload: { type: 'TEXT_MESSAGE_CONTENT', delta } })}\n\n`
const stream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start (value) { controller = value } }), { headers: { 'Content-Type': 'text/event-stream' } })
  return { response, push: (text: string) => controller.enqueue(encode(text)), close: () => controller.close(), fail: () => controller.error(new TypeError('network')) }
}
const tick = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  sessionStorage.clear()
})
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); vi.restoreAllMocks() })

describe('REST reliability', () => {
  it('times out a pending request without retrying a potentially accepted POST', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const result = createRepository().createTask(input)
    const assertion = expect(result).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(15000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('retries a rate-limited run once with the same key and business context', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 202 }))
    const result = createRepository().startTaskRun('session', '问题', 'client', 'prepared', 'scope')
    const assertion = expect(result).resolves.toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body)
    expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe('client')
  })
  it('cancels a rate-limit retry when leaving the session', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })))
    const repository = createRepository()
    const assertion = expect(repository.startTaskRun('session', '问题', 'client')).rejects.toMatchObject({ name: 'AbortError' })
    await tick(); repository.cancelTaskRequests('session')
    await vi.advanceTimersByTimeAsync(3000); await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('preserves interrupt acceptance and sends its reason', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { requested: false } }), { status: 200 }))
    const result = await createRepository().interruptTask('session')
    expect(result).toMatchObject({ interruptRequested: false })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ reason: 'USER_REQUESTED' })
  })
  it('times out while reading a JSON response body', async () => {
    fetchMock.mockImplementation((_url, init) => Promise.resolve({ ok: true, status: 201, headers: new Headers(), text: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }))
    const assertion = expect(createRepository().createTask(input)).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(15000); await assertion
  })
  it('stops after a second 429 and never retries a 503 run', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })))
    const first = expect(createRepository().startTaskRun('session', '问题', 'client')).rejects.toMatchObject({ status: 429 })
    await tick(); await first
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 503 }))
    await expect(createRepository().startTaskRun('session', '问题')).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not duplicate an existing bearer prefix', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'session' } }), { status: 201 }))
    await createRepository(() => 'Bearer existing').createTask(input)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer existing')
  })
})

describe('SSE reliability', () => {
  it('parses CRLF across byte chunks and flushes a trailing frame', async () => {
    const s = stream(); fetchMock.mockResolvedValue(s.response)
    const onEvent = vi.fn()
    stops.push(createRepository().subscribeTaskEvents('session', onEvent))
    await tick()
    const text = frame('a-1').replace(/\n/g, '\r\n')
    const cut = text.indexOf('\r') + 1
    s.push(text.slice(0, cut)); s.push(text.slice(cut)); s.push(frame('a-2', '尾帧').trimEnd()); s.close()
    await tick()
    expect(onEvent.mock.calls.map(([event]) => event.text)).toEqual(['正文', '尾帧'])
  })
  it('reconnects after EOF with a replayable cursor and suppresses repeated deltas', async () => {
    const first = stream(), second = stream()
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    const onEvent = vi.fn(), onError = vi.fn(), onConnected = vi.fn()
    stops.push(createRepository().subscribeTaskEvents('session', onEvent, onError, onConnected))
    await tick(); first.push(frame('a-1')); first.push('id: s-99\nevent: run.progress\ndata: {}\n\n'); first.close()
    await vi.advanceTimersByTimeAsync(1300)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers['Last-Event-ID']).toBe('a-1')
    expect(onError).toHaveBeenCalled()
    second.push(frame('a-1')); second.push(frame('a-2', '新内容')); await tick()
    expect(onEvent.mock.calls.filter(([e]) => e.type === 'agent.message').map(([e]) => e.text)).toEqual(['正文', '新内容'])
    expect(onConnected).toHaveBeenCalledTimes(2)
  })
  it('resumes a disposed subscription without replaying its last processed delta', async () => {
    const first = stream(), second = stream()
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    const repository = createRepository()
    const stop = repository.subscribeTaskEvents('session', vi.fn()); stops.push(stop)
    await tick(); first.push(frame('a-1')); await tick(); stop()
    const onEvent = vi.fn()
    stops.push(repository.subscribeTaskEvents('session', onEvent)); await tick()
    expect(fetchMock.mock.calls[1][1].headers['Last-Event-ID']).toBe('a-1')
    second.push(frame('a-1')); second.push(frame('a-2', '新字')); await tick()
    expect(onEvent.mock.calls.map(([e]) => e.text)).toEqual(['新字'])
  })
  it('reconnects after a read error', async () => {
    const first = stream(), second = stream()
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    stops.push(createRepository().subscribeTaskEvents('session', vi.fn()))
    await tick(); first.fail(); await vi.advanceTimersByTimeAsync(1300)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('counts heartbeat comments as activity and reconnects a silent connection', async () => {
    const first = stream(), second = stream()
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    stops.push(createRepository().subscribeTaskEvents('session', vi.fn()))
    await tick(); await vi.advanceTimersByTimeAsync(20000); first.push(':keep-alive\n\n'); await tick()
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(16000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('cancels pending reconnect when disposed', async () => {
    const s = stream(); fetchMock.mockResolvedValueOnce(s.response)
    const stop = createRepository().subscribeTaskEvents('session', vi.fn())
    stops.push(stop); await tick(); s.close(); await tick(); stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('releases the old subscription when the same session is subscribed again', async () => {
    const first = stream(), second = stream()
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    const repository = createRepository(), oldEvent = vi.fn(), newEvent = vi.fn()
    stops.push(repository.subscribeTaskEvents('session', oldEvent)); await tick()
    stops.push(repository.subscribeTaskEvents('session', newEvent)); await tick()
    second.push(frame('a-2')); await tick(); await vi.advanceTimersByTimeAsync(2000)
    expect(oldEvent).not.toHaveBeenCalled()
    expect(newEvent).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Accept: 'text/event-stream', 'Cache-Control': 'no-cache' })
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBeUndefined()
  })
  it('rejects a successful HTML response without pretending the stream connected', async () => {
    fetchMock.mockResolvedValue(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }))
    const connected = vi.fn(), error = vi.fn()
    stops.push(createRepository().subscribeTaskEvents('session', vi.fn(), error, connected))
    await vi.advanceTimersByTimeAsync(60000)
    expect(connected).not.toHaveBeenCalled()
    expect(error.mock.calls[0][0]).toMatchObject({ code: 'INVALID_EVENT_STREAM', retryable: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 404])('does not reconnect on terminal HTTP %s', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    const onError = vi.fn()
    stops.push(createRepository().subscribeTaskEvents('session', vi.fn(), onError))
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatchObject({ retryable: false, status })
  })
})
