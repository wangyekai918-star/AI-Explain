import './page.css'
import { registerAiExplainBot, ExplainServiceClient, createBrowserSynthesizer } from '../index'
import type { DataSourceUpdate } from '../core/ExplainController'
import type { TeldHubTaskEvent } from '../types'

registerAiExplainBot()
let handler: ((event: TeldHubTaskEvent) => void) | null = null
let generation = 0
let dataset = { label: '2026 年 10 月', orders: 128, energy: 2560, growth: 8 }
const script = () => JSON.stringify({ title: '充电站经营概览', script: [
  { speaker: 'A', text: `现在为你讲解${dataset.label}的经营情况。` },
  { speaker: 'B', text: `当前共完成${dataset.orders}笔充电订单，充电量为${dataset.energy}度。` },
  { speaker: 'A', text: `订单量环比增长${dataset.growth}%，可以结合客流、活动与设备可用率进一步分析。` },
] })
// 本地预览等待时间：模拟线上分析。
const demoAnalysisDelayMs = 8000
async function deliver(text: string) {
  const current = ++generation
  await new Promise(resolve => setTimeout(resolve, demoAnalysisDelayMs))
  if (current !== generation) return []
  handler?.({ id: `demo-${current}`, taskId: 'local-demo', type: 'agent.message', text, streaming: false })
  handler?.({ id: `done-${current}`, taskId: 'local-demo', type: 'session.status_idle', text: '', runState: 'completed' })
  return []
}
const repository = {
  subscribeTaskEvents(_id: string, onEvent: typeof handler, _error: unknown, connected: () => void) {
    handler = onEvent
    queueMicrotask(() => connected?.())
    return () => { generation++; handler = null }
  },
  startTaskRunWithMessages: () => deliver(script()),
  startTaskRun: (_id: string, question: string) => deliver(JSON.stringify({ script: [
    ...question.includes('三段') ? [
      { speaker: 'A', text: `${dataset.label}共完成${dataset.orders}笔订单，充电量${dataset.energy}度。` },
      { speaker: 'A', text: `订单环比增长${dataset.growth}%，还需要结合客流和活动情况分析。` },
      { speaker: 'A', text: '建议继续关注设备可用率和高峰时段表现。这三段回答共用一条连续播放进度。' },
    ] : [{ speaker: 'A', text: `${dataset.label}的示例数据：订单${dataset.orders}笔，充电量${dataset.energy}度，环比增长${dataset.growth}%。${question.includes('增长') ? '增长原因还需结合客流、活动和设备可用率进一步判断。' : '这是本地预设回答，用于体验新数据下的追问。'}` }],
  ] })),
  interruptTask: async () => { generation++; return {} },
}
const service = new ExplainServiceClient({ gatewayBaseUrl: '', transport: async (sid, params) => {
  if (sid.endsWith('queryRobotConfig')) return { state: '1', data: {
    isInterrupt: true, robotSet: { position: 'bottom-right', ext: { avatarDraggable: true } },
    voiceSetting: { voices: [{ role: 'A', displayName: '小电', answerQuestion: true }, { role: 'B', displayName: '小特' }] },
  } }
  if (sid.endsWith('assembleExplain')) {
    const context = (params as { mdContext?: string })?.mdContext
    if (context) dataset = JSON.parse(context)
    return { state: '1', data: { sessionId: 'local-demo', messages: [{ id: 'demo-user', role: 'user', content: JSON.stringify(dataset) }] } }
  }
  throw new Error('本地演示未连接语音识别服务，请使用文字提问。')
} })
const el = document.createElement('teld-ai-explain') as HTMLElement & { start: () => void; refresh: (update: DataSourceUpdate) => Promise<void>; mdContextProvider: () => string; explainService: unknown; repository: unknown; synthesizer: unknown }
el.setAttribute('config-id', 'local-demo')
el.setAttribute('scenario-name', '经营概览')
el.setAttribute('theme', 'light')
document.querySelector('.badge')!.textContent = 'IP 形象 · 模拟数据 · 分析约 8 秒'
el.mdContextProvider = () => JSON.stringify(dataset)
el.explainService = service
el.repository = repository
el.synthesizer = createBrowserSynthesizer()
document.body.append(el)
document.querySelector('#theme')!.addEventListener('change', (event) => {
  const dark = (event.target as HTMLInputElement).checked
  document.documentElement.dataset.demoTheme = dark ? 'dark' : 'light'
  el.setAttribute('theme', dark ? 'dark' : 'light')
})

// 数据源更新演示：取数完成后才生成；快速切换由控制器作废旧结果。
{
  const controls = document.createElement('div')
  controls.className = 'source-controls'
  controls.innerHTML = `<label>数据日期 <input id="data-date" type="date" value="2026-10-28"></label><label>统计范围 <select id="data-scope"><option value="month">月</option><option value="day">日</option><option value="year">年</option></select></label><label class="demo-failure"><input id="fail-update" type="checkbox">模拟更新失败</label>`
  document.querySelector('.stats')!.before(controls)
  let selection = 0
  const update = () => {
    const current = ++selection
    const date = (document.querySelector('#data-date') as HTMLInputElement).value
    if (!date) return
    const [year, month, day] = date.split('-').map(Number)
    const scope = (document.querySelector('#data-scope') as HTMLSelectElement).value
    const label = scope === 'year' ? `${year} 年` : scope === 'day' ? `${year} 年 ${month} 月 ${day} 日` : `${year} 年 ${month} 月`
    const seed = year + month * 13 + day * (scope === 'day' ? 3 : 1)
    const next = { label, orders: 100 + seed % 90, energy: 2100 + seed % 80 * 20, growth: 3 + seed % 12 }
    void el.refresh({ label, mdSource: async () => {
      await new Promise(resolve => setTimeout(resolve, 700))
      if ((document.querySelector('#fail-update') as HTMLInputElement).checked) throw new Error('模拟数据加载失败')
      if (current === selection) {
        const values = document.querySelectorAll('.stats strong')
        values[0].textContent = String(next.orders)
        values[1].textContent = next.energy.toLocaleString()
        values[2].textContent = `${next.growth}%`
      }
      return { mdContext: JSON.stringify(next) }
    } })
  }
  document.querySelector('#data-date')!.addEventListener('change', update)
  document.querySelector('#data-scope')!.addEventListener('change', update)
}

// 主色与明暗模式独立切换；更换颜色不重启播放器。
{
  const palettes = [
    { name: '墨黑', color: '#202020' },
    { name: '靛蓝', color: '#4F46E5' },
    { name: '翡翠绿', color: '#087F6D' },
    { name: '紫罗兰', color: '#7C3AED' },
    { name: '暖橙', color: '#C65324' },
    { name: '玫瑰', color: '#BE3863' },
  ]
  const picker = document.createElement('div')
  picker.className = 'theme-picker'
  picker.setAttribute('role', 'group')
  picker.setAttribute('aria-label', '播放器主题色')
  const label = document.createElement('span')
  label.className = 'theme-picker-label'
  label.textContent = '播放器主题色'
  picker.append(label)
  for (const [index, palette] of palettes.entries()) {
    const button = document.createElement('button')
    button.className = 'theme-swatch'
    button.type = 'button'
    button.setAttribute('aria-label', `${palette.name}主题`)
    button.setAttribute('aria-pressed', String(index === 0))
    button.title = `${palette.name} ${palette.color}`
    const dot = document.createElement('span')
    dot.className = 'theme-swatch-dot'
    dot.style.backgroundColor = palette.color
    dot.setAttribute('aria-hidden', 'true')
    button.append(dot)
    button.addEventListener('click', () => {
      picker.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)))
      // 墨黑沿用原深浅主题的中性色，其余使用品牌色。
      if (index === 0) el.removeAttribute('accent-color')
      else el.setAttribute('accent-color', palette.color)
    })
    picker.append(button)
  }
  document.querySelector('.stats')!.before(picker)
}
