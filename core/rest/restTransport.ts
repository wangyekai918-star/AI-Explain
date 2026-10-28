/** 只展示固定错误说明，避免把网关 HTML、内部堆栈或地址带入聊天页面。 */
export class TeldHubRestError extends Error {
  constructor (message: string, public readonly status = 0, public readonly code = '', public readonly retryAfterMs = 0, public readonly retryable = false) {
    super(message)
    this.name = 'TeldHubRestError'
  }
}

export const abortError = () => new DOMException('请求已取消', 'AbortError')

export function waitWithSignal (milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const cancel = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, milliseconds)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export function retryAfterMs (value: string | null): number {
  if (!value) return 2000
  const seconds = Number(value)
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(duration) ? Math.min(30000, Math.max(0, duration)) : 2000
}

export function responseError (status: number, payload: Record<string, unknown>, retryAfter: string | null): TeldHubRestError {
  const descriptions: Record<number, string> = {
    400: '请求参数无效，请重新同步后重试',
    401: '登录已失效，请重新登录',
    403: '无权访问当前会话或专家',
    404: '会话不存在或当前用户无权访问',
    409: '消息幂等键冲突，请重新发送',
    429: '请求过于频繁或队列已满，请稍后重试',
    503: '服务暂不可用，请稍后重试',
  }
  const code = typeof payload.code === 'string' ? payload.code : ''
  return new TeldHubRestError(`[REST ${status}] ${descriptions[status] || '服务请求失败，请稍后重试'}`, status, code, retryAfterMs(retryAfter), status === 429 || status >= 500)
}

/** 超时覆盖响应头及普通 JSON 响应体；SSE 的响应体由心跳看门狗单独管理。 */
export async function restRequest (url: string, token: string, init: RequestInit, stream = false): Promise<{ response: Response, payload: Record<string, any> }> {
  const controller = new AbortController()
  const parent = init.signal
  let timedOut = false
  const cancel = () => controller.abort()
  if (parent?.aborted) throw abortError()
  parent?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
  try {
    const normalizedToken = token.trim().replace(/^Bearer\s+/i, '')
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...(stream ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${normalizedToken}`, ...init.headers },
    })
    // 失败响应也不等待潜在的无限流响应体。
    let payload: Record<string, any> = {}
    if (!stream) {
      const text = await response.text()
      try { const parsed = text ? JSON.parse(text) : {}; if (parsed && typeof parsed === 'object') payload = parsed } catch { /* 固定错误文案 */ }
    }
    if (!response.ok) throw responseError(response.status, payload, response.headers.get('Retry-After'))
    return { response, payload }
  } catch (error) {
    if (timedOut) throw new TeldHubRestError('请求超时，未确认服务端结果，请重新同步后重试', 0, 'REQUEST_TIMEOUT', 0, true)
    if (parent?.aborted) throw abortError()
    if (error instanceof TeldHubRestError) throw error
    throw new TeldHubRestError('网络连接异常，请检查网络后重试', 0, 'NETWORK_ERROR', 0, true)
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', cancel)
  }
}
