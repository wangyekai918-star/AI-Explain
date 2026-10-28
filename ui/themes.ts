/**
 * 组件主题 token：dark=中性深色 / light=柔和浅白。
 * 所有 UI 颜色一律走 var(--aeb-*)，宿主可在元素上直接覆写任意变量
 * （CSS 变量穿透 shadow DOM）。queryRobotConfig 的 themeColor/backgroundColor
 * 等以行内样式覆盖在基础 token 之上。
 */

export type ExplainTheme = 'dark' | 'light'

export type ThemeTokens = Record<string, string>

export const themeTokens: Record<ExplainTheme, ThemeTokens> = {
  light: {
    '--aeb-bg': '#ffffff',
    '--aeb-bg-soft': '#f5f5f5',
    '--aeb-fg': '#202020',
    '--aeb-fg-secondary': '#808080',
    '--aeb-border': '#ebebeb',
    '--aeb-accent': '#202020',
    '--aeb-accent-fg': '#ffffff',
    '--aeb-accent-soft': 'rgba(0, 0, 0, 0.06)',
    '--aeb-highlight': '#eeeeee',
    '--aeb-focus': '#808080',
    '--aeb-shadow': '0 20px 70px rgba(0, 0, 0, 0.10), 0 2px 10px rgba(0, 0, 0, 0.03)',
    '--aeb-radius': '28px',
    '--aeb-panel-width': '400px',
    '--aeb-panel-height': '700px',
    '--aeb-avatar-size': '70px',
    '--aeb-font-size': '14px',
    '--aeb-z': '2000',
  },
  dark: {
    '--aeb-bg': '#1f1f1f',
    '--aeb-bg-soft': '#2c2c2c',
    '--aeb-fg': '#eeeeee',
    '--aeb-fg-secondary': '#a3a3a3',
    '--aeb-border': '#383838',
    '--aeb-accent': '#eeeeee',
    '--aeb-accent-fg': '#1f1f1f',
    '--aeb-accent-soft': 'rgba(255, 255, 255, 0.10)',
    '--aeb-highlight': '#363636',
    '--aeb-focus': '#a3a3a3',
    '--aeb-shadow': '0 20px 70px rgba(0, 0, 0, 0.28), 0 2px 10px rgba(0, 0, 0, 0.12)',
    '--aeb-radius': '28px',
    '--aeb-panel-width': '400px',
    '--aeb-panel-height': '700px',
    '--aeb-avatar-size': '70px',
    '--aeb-font-size': '14px',
    '--aeb-z': '2000',
  },
}

/**
 * themeColor → 预制主题 key（宿主未显式传 theme 属性时的判定依据）：
 * 十六进制（#RGB/#RRGGBB）按 Rec.601 感知亮度判定——「明确偏深」（< 0.4，
 * 如大屏深蓝 #0a1c38）→ dark，其余（含中亮品牌蓝 #1e88e5）→ light；
 * 阈值取 0.4 而非 0.5 是因为 dark 预制的点缀色本身偏亮（深底上要高对比），
 * 亮度居中的品牌色多为浅色场景。非十六进制字面量（如直填 'dark'/'light'）
 * 原样返回；空值返回 null。返回值不保证是合法主题 key，调用方需校验兜底。
 */
export function themeFromColor (color?: string | null): ExplainTheme | string | null{
  const m = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec((color || '').trim())
  if (!m) return color||null;
  const hex = (m[1] ? m[1].split('').map(c => c + c).join('') : m[2]!).toLowerCase()
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.4 ? 'dark' : 'light'
}

/** 媒体秒 → 'mm:ss'（超过 1 小时升 'hh:mm:ss'） */
export function formatClock (sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}
