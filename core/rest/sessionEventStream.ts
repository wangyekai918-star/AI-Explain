import { abortError, TeldHubRestError, waitWithSignal } from './restTransport'

/** SSE 游标持久化所需的最小存储接口；宿主可注入自定义实现。 */
export type StreamStorage = { getItem (key: string): string | null, setItem (key: string, value: string): void, removeItem (key: string): void }

const memoryStorage: StreamStorage = (() => {
  const map = new Map<string, string>()
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)) }, removeItem: key => { map.delete(key) } }
})()

/** 默认走 sessionStorage；禁用存储（隐私模式/非浏览器宿主）时退化为内存，实时能力不受影响。 */
export function defaultStreamStorage (): StreamStorage {
  try { if (typeof sessionStorage !== 'undefined') return sessionStorage } catch { /* 禁用存储仍可实时使用 */ }
  return memoryStorage
}

type StreamOptions = {
  open: (signal: AbortSignal, cursor: string) => Promise<Response>
  onFrame: (frame: string) => void
  onError?: (error: TeldHubRestError) => void
  onConnected?: () => void
  cursorKey: string
  storage?: StreamStorage
}

/** 每个订阅只保留一条连接；游标按登录身份隔离，信号事件不作为恢复位置。 */
export function subscribeSessionStream (options: StreamOptions): () => void {
  const storage = options.storage || defaultStreamStorage()
  const lifetime = new AbortController()
  let cursor = ''
  try { cursor = storage.getItem(options.cursorKey) || '' } catch { /* 禁用存储仍可实时使用 */ }
  if (!/^(d-|a-)/.test(cursor)) cursor = ''
  const seen = new Set<string>(cursor ? [cursor] : [])
  let cursorTimer: ReturnType<typeof setTimeout> | undefined
  const persistCursor = () => {
    clearTimeout(cursorTimer)
    cursorTimer = undefined
    if (cursor) { try { storage.setItem(options.cursorKey, cursor) } catch { /* 内存游标仍有效 */ } }
  }
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const stop = () => {
    lifetime.abort()
    persistCursor()
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', stop)
    void activeReader?.cancel().catch(() => {})
  }
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', stop)
  const dispatch = (frame: string) => {
    if (lifetime.signal.aborted) return
    const id = frame.match(/^id:\s*(.+)$/m)?.[1]?.trim()
    const raw = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!raw) return // 注释心跳仅刷新字节活跃时间。
    try { JSON.parse(raw) } catch { return }
    if (id && seen.has(id)) return
    options.onFrame(frame)
    if (id) {
      seen.add(id)
      if (seen.size > 4096) seen.delete(seen.values().next().value!)
      if (/^(d-|a-)/.test(id)) {
        cursor = id
        if (!cursorTimer) cursorTimer = setTimeout(persistCursor, 1000)
      }
    }
  }
  const readChunk = (reader: ReadableStreamDefaultReader<Uint8Array>) => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const signal = lifetime.signal
    if (signal.aborted) { reject(abortError()); return }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
    const cancel = () => { done(); reject(abortError()) }
    const timer = setTimeout(() => { done(); reject(new TeldHubRestError('实时连接 30 秒未收到心跳，正在重新连接', 0, 'HEARTBEAT_TIMEOUT', 0, true)) }, 30000)
    signal.addEventListener('abort', cancel, { once: true })
    reader.read().then(value => { done(); resolve(value) }, error => { done(); reject(error) })
  })
  void (async () => {
    let attempts = 0
    while (!lifetime.signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await options.open(lifetime.signal, cursor)
        if (lifetime.signal.aborted) { void response.body?.cancel().catch(() => {}); return }
        if (!response.body || !response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) {
          void response.body?.cancel().catch(() => {})
          throw new TeldHubRestError('实时接口未返回有效事件流，请重新同步', response.status, 'INVALID_EVENT_STREAM')
        }
        reader = response.body.getReader()
        activeReader = reader
        options.onConnected?.()
        const connectedAt = Date.now()
        const decoder = new TextDecoder()
        let buffer = ''
        let pendingCR = false
        const consume = (text: string, eof = false) => {
          // 暂存 chunk 尾部的 CR，避免跨 chunk 的 CRLF 被误判成两个换行。
          let next = (pendingCR ? '\r' : '') + text
          pendingCR = !eof && next.endsWith('\r')
          if (pendingCR) next = next.slice(0, -1)
          buffer += next.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          let index: number
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            dispatch(buffer.slice(0, index))
            buffer = buffer.slice(index + 2)
          }
          if (eof && buffer.trim()) { dispatch(buffer); buffer = '' }
        }
        while (!lifetime.signal.aborted) {
          const { value, done } = await readChunk(reader)
          consume(decoder.decode(value, { stream: !done }), done)
          // 稳定连接后再重置退避，避免服务端立即关闭造成重连风暴。
          if (Date.now() - connectedAt >= 30000) attempts = 0
          if (done) throw new TeldHubRestError('实时连接已断开，正在重新连接', 0, 'STREAM_CLOSED', 0, true)
        }
      } catch (cause) {
        if (lifetime.signal.aborted) return
        const error = cause instanceof TeldHubRestError ? cause : new TeldHubRestError('实时连接异常，正在重新连接', 0, 'STREAM_ERROR', 0, true)
        options.onError?.(error)
        if (!error.retryable) { stop(); return }
        const delay = Math.max(error.status === 429 ? error.retryAfterMs : 0, Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)) * (0.8 + Math.random() * 0.4))
        // 在等待退避前释放旧连接，避免占满浏览器同源连接数。
        void reader?.cancel().catch(() => {})
        try { await waitWithSignal(delay, lifetime.signal) } catch { return }
      } finally {
        void reader?.cancel().catch(() => {})
        try { reader?.releaseLock() } catch { /* 未完成的 read 在 cancel 后退出 */ }
        if (activeReader === reader) activeReader = undefined
      }
    }
  })()
  return stop
}
