import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplainServiceClient, ExplainServiceError } from './explainServiceClient'

const transportMock = vi.fn()

describe('ExplainServiceClient', () => {
  beforeEach(() => transportMock.mockReset())

  it('wraps calls in the SG filter envelope and unwraps TResponse data', async () => {
    transportMock.mockResolvedValue({ state: '1', errcode: '0', data: { robotSet: { robotImage: 'a.png' } } })
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    const config = await client.queryRobotConfig('1001')

    expect(transportMock).toHaveBeenCalledWith('AIP-Mgr-queryRobotConfig', { configId: '1001' })
    expect(config).toEqual({ robotSet: { robotImage: 'a.png' } })
  })

  it('sends assembleExplain with configId and only the provided MD fields', async () => {
    transportMock.mockResolvedValue({ state: '1', data: { sessionId: 'ses_1', messages: [{ id: 'm', role: 'user', content: '# MD' }] } })
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    await client.assembleExplain('1001', { mdContext: '# MD' })

    expect(transportMock).toHaveBeenCalledWith('AIP-Mgr-assembleExplain', { configId: '1001', mdContext: '# MD' })

    await client.assembleExplain('1001', { mdSearchParam: '{"docId":"D1"}' })
    expect(transportMock).toHaveBeenLastCalledWith('AIP-Mgr-assembleExplain', { configId: '1001', mdSearchParam: '{"docId":"D1"}' })
  })

  it('strips system-role messages from the assembleExplain result', async () => {
    transportMock.mockResolvedValue({
      state: '1',
      data: {
        sessionId: 'ses_1',
        messages: [
          { id: 's1', role: 'system', content: '你是经营数据讲解助手' },
          { id: 'u1', role: 'user', content: '# 2026Q1 销量分析' },
        ],
      },
    })
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    const result = await client.assembleExplain('1001', { mdContext: '# MD' })

    expect(result.messages).toEqual([{ id: 'u1', role: 'user', content: '# 2026Q1 销量分析' }])
  })

  it('normalizes a missing messages field of assembleExplain to an empty list', async () => {
    transportMock.mockResolvedValue({ state: '1', data: { sessionId: 'ses_1' } })
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    const result = await client.assembleExplain('1001', { mdContext: '# MD' })

    expect(result.messages).toEqual([])
  })

  it('throws a business error carrying errcode/errmsg when state is not 1', async () => {
    transportMock.mockResolvedValue({ state: '0', errcode: '1002', errmsg: '对接配置不存在' })
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    await expect(client.queryRobotConfig('404')).rejects.toMatchObject({
      name: 'ExplainServiceError',
      errcode: '1002',
      errmsg: '对接配置不存在',
    })
  })

  it('treats null data of a successful response as a data error', async () => {
    transportMock.mockResolvedValue({ state: '1', errcode: '0', data: null })
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    await expect(client.queryRobotConfig('1')).rejects.toMatchObject({ errcode: '1002' })
  })

  it('posts the filter envelope with a bearer token through the default transport', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: '1', data: { text: '你好' } }), { status: 200 }))
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw/', getToken: () => 'tk', fetchImpl: fetchMock as unknown as typeof fetch })

    const result = await client.recognizeSpeech('UklGRg==', 'wav')

    expect(fetchMock).toHaveBeenCalledWith('https://gw/AIP-Mgr-recognizeSpeech', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer tk', 'Content-Type': 'application/json' }),
    }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ filter: { data: 'UklGRg==', format: 'wav' } })
    expect(result).toEqual({ text: '你好' })
  })

  it('maps a bare HTTP failure of the default transport to an external error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 }))
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', fetchImpl: fetchMock as unknown as typeof fetch })

    await expect(client.queryRobotConfig('1')).rejects.toBeInstanceOf(ExplainServiceError)
  })

  it('rejects empty required fields before any transport call', async () => {
    const client = new ExplainServiceClient({ gatewayBaseUrl: 'https://gw', transport: transportMock })

    await expect(client.queryRobotConfig(' ')).rejects.toMatchObject({ errcode: '1001' })
    await expect(client.recognizeSpeech('', 'wav')).rejects.toMatchObject({ errcode: '1001' })
    expect(transportMock).not.toHaveBeenCalled()
  })
})
