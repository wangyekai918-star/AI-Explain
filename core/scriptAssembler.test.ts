import { describe, expect, it } from 'vitest'
import { extractScriptDoc, looksLikeJsonDocument, ScriptAssembler } from './scriptAssembler'

const docText = JSON.stringify({
  title: '测试讲解',
  script: [
    { speaker: 'A', text: '第一句。', style: '平稳', segment: '开场' },
    { speaker: 'B', text: '第二句。' },
    { speaker: '小特', text: '第三句。' },
    { speaker: 'A', text: '   ' },
  ],
})

describe('extractScriptDoc', () => {
  it('parses a bare JSON document, normalizes speakers and drops empty items', () => {
    const doc = extractScriptDoc(docText)
    expect(doc?.title).toBe('测试讲解')
    expect(doc?.script).toEqual([
      { speaker: 'A', text: '第一句。', style: '平稳' },
      { speaker: 'B', text: '第二句。' },
      { speaker: 'B', text: '第三句。' },
    ])
  })

  it('extracts the JSON object embedded after preamble text', () => {
    const doc = extractScriptDoc(`任务(role)，双人模式，生成讲解脚本。\n\n${docText}`)
    expect(doc?.script).toHaveLength(3)
  })

  it('extracts JSON inside a markdown code fence', () => {
    const doc = extractScriptDoc('```json\n' + docText + '\n```')
    expect(doc?.script[0].text).toBe('第一句。')
  })

  it('returns null for non-JSON text or documents without usable script items', () => {
    expect(extractScriptDoc('【A】你好。今天讲讲充电站。')).toBeNull()
    expect(extractScriptDoc('{"title":"无脚本"}')).toBeNull()
    expect(extractScriptDoc('{"script":[{"speaker":"A"}]}')).toBeNull()
    expect(extractScriptDoc('{"script":[]}')).toBeNull()
  })
})

describe('looksLikeJsonDocument', () => {
  it('detects bare and fenced JSON fragments', () => {
    expect(looksLikeJsonDocument('{"title":')).toBe(true)
    expect(looksLikeJsonDocument('```json\n{"a"')).toBe(true)
    expect(looksLikeJsonDocument('【A】第一句。')).toBe(false)
  })
})

describe('ScriptAssembler.feedFinalDocument', () => {
  it('builds lines from the JSON doc with explicit speakers (no duetMode)', () => {
    const assembler = new ScriptAssembler({ lineIdPrefix: 'explain' })
    const lines = assembler.feedFinalDocument(`前置说明。\n${docText}`)
    expect(lines.map(l => [l.speaker, l.text])).toEqual([
      ['A', '第一句。'],
      ['B', '第二句。'],
      ['B', '第三句。'],
    ])
    expect(lines[0].style).toBe('平稳') // style 透传后端合成
    expect(lines[0].lineId).toBe('explain-1')
  })

  it('emits nothing for a truncated JSON document (interrupt remnant)', () => {
    const assembler = new ScriptAssembler()
    expect(assembler.feedFinalDocument('{"title":"x","script":[{"speaker":"A","te')).toEqual([])
  })

  it('falls back to mark-based assembly for non-JSON documents', () => {
    const assembler = new ScriptAssembler({ duetMode: true, lineIdPrefix: 'explain' })
    const lines = assembler.feedFinalDocument('【A】第一句。【B】那么第二句。')
    expect(lines.map(l => [l.speaker, l.text])).toEqual([
      ['A', '第一句。'],
      ['B', '那么第二句。'],
    ])
  })

  it('keeps lineId sequence continuous across feed and feedFinalDocument', () => {
    const assembler = new ScriptAssembler({ lineIdPrefix: 'explain' })
    const streamed = assembler.feed('增量句子。')
    const final = assembler.feedFinalDocument(docText)
    expect(streamed[0].lineId).toBe('explain-1')
    expect(final[0].lineId).toBe('explain-2')
  })
})
