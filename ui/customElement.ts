import { defineCustomElement } from 'vue'
import AiExplainBot from './AiExplainBot.ce.vue'

const TeldAiExplainBase = defineCustomElement(AiExplainBot)

/**
 * 把 defineExpose 的成员补挂到自定义元素实例（老运行时兜底）。
 *
 * vue ≥3.4 的 VueElement 原生把 expose 成员挂到元素实例（el.start() 直接可用）；
 * 老运行时每次连接（首次及重连）都会走到这里，新运行时原生已挂、宿主 property
 * 注入已占用的成员一律不覆盖。
 */
export function patchExposedToElement (el: HTMLElement): void {
  const exposed = (el as unknown as { _instance?: { exposed?: Record<string, unknown> | null } | null })._instance?.exposed
  if (!exposed) return
  const host = el as unknown as Record<string, unknown>
  for (const key of Object.keys(exposed)) {
    // 必须用 in 判断而非取值比较：声明 props（如 bot）带 accessor，getter 返回 undefined
    // 但赋值会触发 setter 写进组件 props.bot，把 exposed 的 computed 当控制器注入（ensureBot 失效）
    if (key in host) continue
    host[key] = exposed[key]
  }
}

/**
 * teld-ai-explain 自定义元素（兼容层）。
 * - vue ≥3.3：defineExpose 的成员挂到元素实例（el.play() / el.bot / el.ask(...)）
 * - 老运行时（vue < 3.4，如平台 3.3.4）：connectedCallback 后经 patchExposedToElement
 *   从内部 _instance.exposed 补挂，el.start() 等命令式 API 版本无关
 * - 函数/对象配置经 property 注入（el.tokenProvider = fn 等，3.3 已支持 property→props）
 * - 事件：defineEmits 以 CustomEvent 派发（bot-start/bot-state/bot-subtitle/
 *   bot-ask/bot-answer/bot-error/bot-close），detail 为负载
 */
class TeldAiExplainCompatElement extends TeldAiExplainBase {
  connectedCallback () {
    super.connectedCallback()
    patchExposedToElement(this)
  }
}

/** 导出保持原名（外部引用 TeldAiExplainElement 的地方不受影响） */
export const TeldAiExplainElement = TeldAiExplainCompatElement

/** 注册自定义元素；重复注册安全（幂等）。 */
export function registerAiExplainBot (tag = 'teld-ai-explain'): void {
  if (typeof customElements === 'undefined') return
  if (!customElements.get(tag)) customElements.define(tag, TeldAiExplainCompatElement)
}
