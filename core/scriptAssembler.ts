import type { ScriptLine } from './dialoguePlayer'

/** 无句读时的强制切句上限：防止长句无标点导致首播延迟过大 */
const MAX_LINE_CHARS = 60

/**
 * 段首角色标记（双人讲解稿）。支持【A】/【B】、A：/B：、小电：/小特：。
 * 正式标记格式待后端确认，新增格式只需扩展此正则与 resolveSpeakerMark。
 */
const SPEAKER_MARK = /^\s*(?:【([AB])】|([AB])[：:]\s*|(小电|小特)[：:]\s*)/

function resolveSpeakerMark (text: string): { speaker: 'A' | 'B', rest: string } | null {
  const m = text.match(SPEAKER_MARK)
  if (!m) return null
  const speaker = m[1] || m[2] || (m[3] === '小特' ? 'B' : 'A')
  return { speaker: speaker as 'A' | 'B', rest: text.slice(m[0].length) }
}

/** 讲解稿 JSON 文档（实测 WorkHub assistant 定稿形态）；style 透传后端合成，segment 不透传 */
export type ExplainScriptDoc = { title: string | null, script: Array<{ speaker: 'A' | 'B', text: string, style?: string }> }

const normalizeSpeaker = (raw: unknown): 'A' | 'B' => {
  const value = String(raw ?? '').trim()
  return value === 'B' || value === 'b' || value === '小特' ? 'B' : 'A'
}

/** 取首个 { 到末个 } 的子串，兼容前导说明与 ```json 围栏；无括号对返回原串交由解析失败兜底 */
const sliceJsonObject = (text: string): string => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/**
 * 从 assistant 定稿全文提取 JSON 讲解稿；非 JSON 文档返回 null（交回标记/纯文本切句）。
 * 实测正文可能带前导说明或围栏：先整篇直解，失败再取 {…} 子串；script 须为数组且含非空 text 项。
 */
export function extractScriptDoc (text: string): ExplainScriptDoc | null {
  const trimmed = text.trim()
  if (!trimmed.includes('{')) return null
  for (const candidate of [trimmed, sliceJsonObject(trimmed)]) {
    let parsed: unknown
    try { parsed = JSON.parse(candidate) } catch { continue }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).script)) continue
    const record = parsed as Record<string, unknown>
    const script = (record.script as unknown[])
      .map(item => (item && typeof item === 'object' ? item as Record<string, unknown> : null))
      .filter((item): item is Record<string, unknown> => !!item && typeof item.text === 'string' && !!item.text.trim())
      .map(item => ({
        speaker: normalizeSpeaker(item.speaker),
        text: String(item.text).trim(),
        ...(typeof item.style === 'string' && item.style.trim() ? { style: item.style.trim() } : {}),
      }))
    if (!script.length) continue
    const title = record.title
    return { title: typeof title === 'string' && title.trim() ? title : null, script }
  }
  return null
}

/** 是否形似 JSON 文档（含中断残稿）：拦截碎片，防止被当正文切句 */
export function looksLikeJsonDocument (text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('```')
}

/**
 * 讲解稿流式组装器（headless）：WorkHub agent.message 增量 → 切句 → 有序行流。
 * - 句读（。！？!?；;\n）切句，标点保留在行内；无句读超 MAX_LINE_CHARS 强制切
 * - 单人模式：全部行 speaker='A'（段首标记仅剥离）
 * - 双人模式：解析段首角色标记，标记后所有句子归该角色，直至下一个标记
 */
export class ScriptAssembler {
  private buffer = ''
  private seq = 0
  private activeSpeaker: 'A' | 'B' = 'A'

  constructor (private readonly options: { duetMode?: boolean, lineIdPrefix?: string } = {}) {}

  /** 喂入增量，返回本次切出的行（可能为空） */
  feed (delta: string): ScriptLine[] {
    if (!delta) return []
    this.buffer += delta
    return this.drain(false)
  }

  /**
   * 定稿全文路径：JSON 讲解稿优先（实测 WorkHub 形态，显式 speaker 直接生效）；
   * 半截 JSON（如中断残稿）不出行防碎片；其余回退标记/句读切句。
   */
  feedFinalDocument (text: string): ScriptLine[] {
    const doc = extractScriptDoc(text)
    if (doc) return doc.script.map(item => this.pushLine(item.text, item.speaker, item.style))
    if (looksLikeJsonDocument(text)) return []
    return [...this.feed(text), ...this.flush()]
  }

  /** 收口：把残余缓冲作为最后一行吐出（可能为空行则忽略） */
  flush (): ScriptLine[] {
    return this.drain(true)
  }

  reset () {
    this.buffer = ''
    this.seq = 0
    this.activeSpeaker = 'A'
  }

  /** 出行统一入口：lineId 序列与角色语义唯一归口；explicitSpeaker/style 供 JSON 显式值直传 */
  private pushLine (text: string, explicitSpeaker?: 'A' | 'B', style?: string): ScriptLine | null {
    let cleaned = text.replace(/\n/g, '').trim()
    if (!cleaned) return null
    let speaker = explicitSpeaker
    if (!speaker) {
      // 段首角色标记：双人模式切换激活角色，标记文本不入稿
      const mark = resolveSpeakerMark(cleaned)
      if (mark) {
        if (this.options.duetMode) this.activeSpeaker = mark.speaker
        cleaned = mark.rest.trim()
      }
      if (!cleaned) return null
      speaker = this.options.duetMode ? this.activeSpeaker : 'A'
    }
    return {
      lineId: `${this.options.lineIdPrefix || 'line'}-${++this.seq}`,
      speaker,
      text: cleaned,
      ...(style ? { style } : {}),
    }
  }

  private drain (final: boolean): ScriptLine[] {
    const lines: ScriptLine[] = []
    let segment = ''

    const emit = (text: string) => {
      const line = this.pushLine(text)
      if (line) lines.push(line)
    }

    for (const char of this.buffer) {
      if (char === '\n') { emit(segment); segment = ''; continue }
      segment += char
      if ('。！？!?；;'.includes(char)) { emit(segment); segment = '' ; continue }
      if (segment.length >= MAX_LINE_CHARS) { emit(segment); segment = '' }
    }

    this.buffer = segment
    if (final) {
      emit(this.buffer)
      this.buffer = ''
    }
    return lines
  }
}
