import type { ExplainAssembleResult, ExplainServiceErrorCode, RobotConfig, SpeechRecognitionResult } from '../types'

/** 讲解管理服务统一响应结构（TResponse）。 */
export type TeldResponse<T> = { state?: string, errcode?: string, errmsg?: string, errstack?: string, data?: T }

/**
 * 传输通道：把一次 SG 方法调用送到讲解管理服务。
 * 默认实现为 POST {gatewayBaseUrl}/{SID} + JSON {filter} + Bearer；
 * 依赖 TFF ajax 的宿主可注入自定义实现，例如：
 *   (sid, filter) => TFF.common.ajax.getDataAsync({
 *     url: TFF.common.ajax.getServiceUrl(sid),
 *     data: { request: JSON.stringify({ filter }) },
 *   })
 */
export type ExplainTransport = (sid: string, filter: Record<string, unknown>) => Promise<unknown>

export interface ExplainServiceClientOptions {
  /** SG 网关基址（默认 transport 拼接为 {base}/{SID}）。 */
  gatewayBaseUrl: string
  /** 默认 transport 的 Bearer 令牌提供者。 */
  getToken?: () => string
  /** 自定义传输通道；注入后 gatewayBaseUrl/getToken 不参与调用。 */
  transport?: ExplainTransport
  /** SID 前缀，默认 AIP-Mgr（对外接口文档 SID 规则）。 */
  sidPrefix?: string
  /** 测试可注入的 fetch 实现。 */
  fetchImpl?: typeof fetch
}

/** 讲解管理服务业务失败（TResponse state!=1）。errcode 1001~1004 见对外接口文档。 */
export class ExplainServiceError extends Error {
  constructor (message: string, public readonly errcode: ExplainServiceErrorCode, public readonly errmsg = '') {
    super(message)
    this.name = 'ExplainServiceError'
  }
}

/**
 * 讲解管理服务适配层（headless，无框架依赖）。
 * 接口方法：queryRobotConfig / assembleExplain / recognizeSpeech；
 * synthesizeSpeech 为预留（时序图形态=传文本→音频流，SID 与出入参待文档补充，
 * 联调时如对不上只需调整本类，内核不感知）。
 */
export class ExplainServiceClient {
  private readonly fetchImpl: typeof fetch

  constructor (private readonly options: ExplainServiceClientOptions) {
    this.fetchImpl = options.fetchImpl || ((input, init) => fetch(input, init))
  }

  /** 查询机器人配置（形象样式 + 打断配置）。 */
  async queryRobotConfig (configId: string): Promise<RobotConfig> {
    return this.invoke<RobotConfig>('queryRobotConfig', { configId: this.required(configId, 'configId') })
  }

  /**
   * 讲解组装：服务端取 MD + 组装提示词 + 创建 WorkHub 会话。
   * mdContext（data_access_type=5 直接传 MD）与 mdSearchParam（=1 透传查询参数）二选一。
   * 出参只保留业务消息：role=system 的提示词已由服务端在创建会话时注入，
   * /runs 转发侧不再携带（联调适配，见开发指南第八节）。
   */
  async assembleExplain (configId: string, md: { mdContext?: string, mdSearchParam?: string } = {}): Promise<ExplainAssembleResult> {
    const filter: Record<string, unknown> = { configId: this.required(configId, 'configId') }
    if (md.mdContext != null && md.mdContext !== '') filter.mdContext = md.mdContext
    if (md.mdSearchParam != null && md.mdSearchParam !== '') filter.mdSearchParam = md.mdSearchParam
    const result = await this.invoke<ExplainAssembleResult>('assembleExplain', filter)
    return { ...result, messages: (result.messages || []).filter((message) => message.role !== 'system') }
  }

  /** 单次语音识别：音频 Base64 整段上传（wav/mp3/ogg/opus），一次返回文本。 */
  async recognizeSpeech (data: string, format: 'wav' | 'mp3' | 'ogg' | 'opus'): Promise<SpeechRecognitionResult> {
    if (!data) throw new ExplainServiceError('[AIP-Mgr 1001] 音频数据不能为空', '1001', '音频数据不能为空')
    return this.invoke<SpeechRecognitionResult>('recognizeSpeech', { data, format })
  }

  /**
   * 预留：语音合成（传文本 → 音频流）。SID/出入参待对外接口文档补充后对齐，
   * 当前透传 filter，返回原始 data 由调用方解释。
   */
  async synthesizeSpeech (filter: Record<string, unknown>): Promise<unknown> {
    return this.invoke<unknown>('synthesizeSpeech', filter)
  }

  /** 泛化调用：宿主可直达任何 AIP-Mgr 方法（含后续新增接口）。 */
  async invoke<T> (methodName: string, filter: Record<string, unknown>): Promise<T> {
    const sid = `${this.options.sidPrefix || 'AIP-Mgr'}-${methodName}`
    const raw = this.options.transport
      ? await this.options.transport(sid, filter)
      : await this.postFilter(sid, filter)
    return this.unwrap<T>(raw, sid)
  }

  private required (value: string, name: string): string {
    const trimmed = (value || '').trim()
    if (!trimmed) throw new ExplainServiceError(`[AIP-Mgr 1001] ${name} 不能为空`, '1001', `${name} 不能为空`)
    return trimmed
  }

  private async postFilter (sid: string, filter: Record<string, unknown>): Promise<unknown> {
    const base = this.options.gatewayBaseUrl.replace(/\/+$/, '')
    const response = await this.fetchImpl(`${base}/${sid}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.options.getToken ? { Authorization: `Bearer ${this.options.getToken()}` } : {}),
      },
      body: JSON.stringify({ filter }),
    })
    const text = await response.text()
    let payload: unknown = null
    try { payload = text ? JSON.parse(text) : null } catch { /* 非 JSON 交由 unwrap 报固定错误 */ }
    if (!response.ok && (!payload || typeof payload !== 'object')) {
      throw new ExplainServiceError(`[AIP-Mgr] 网关请求失败（HTTP ${response.status}）`, '1004')
    }
    return payload
  }

  private unwrap<T> (raw: unknown, sid: string): T {
    const response = (raw && typeof raw === 'object' ? raw : {}) as TeldResponse<T>
    if (String(response.state) !== '1') {
      const errcode = String(response.errcode || '1004')
      const errmsg = String(response.errmsg || '讲解服务调用失败')
      throw new ExplainServiceError(`[${sid} ${errcode}] ${errmsg}`, errcode, errmsg)
    }
    if (response.data == null) throw new ExplainServiceError(`[${sid} 1002] 服务返回数据为空`, '1002', '服务返回数据为空')
    return response.data
  }
}

export const createExplainServiceClient = (options: ExplainServiceClientOptions): ExplainServiceClient => new ExplainServiceClient(options)
