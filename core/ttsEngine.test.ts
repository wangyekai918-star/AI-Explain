import { describe, expect, it, vi } from 'vitest'
import {
  createBatchSynthesizer,
  createBrowserSynthesizer,
  createCompositeSynthesizer,
  estimateLineSeconds,
  makeAudioHandle,
  makeSilenceHandle,
  supportsSpeechSynthesis,
  type AudioHandle,
  type TtsLine,
  type TtsSynthesizer,
} from './ttsEngine'

const line = (id: string, text = '一二三四'): TtsLine => ({ lineId: id, speaker: 'A', text })

describe('estimateLineSeconds', () => {
  it('uses 0.22s per char with a 1.2s floor', () => {
    expect(estimateLineSeconds('')).toBe(1.2)
    expect(estimateLineSeconds('五')).toBe(1.2)
    expect(estimateLineSeconds('一二三四五六七八九十')).toBeCloseTo(2.2)
  })
})

describe('silence handle', () => {
  it('advances media seconds by rate and resolves at the end', async () => {
    const handle = makeSilenceHandle('一二三四')
    handle.rate = 4 // 1.2s 媒体秒 ÷ 4 ≈ 0.3s 墙钟
    await handle.play()
    expect(handle.currentTime).toBe(handle.duration)
  })

  it('keeps the breakpoint after stop and resumes from it', async () => {
    const handle = makeSilenceHandle('一二三四五六七八九十') // 2.2s
    handle.rate = 8
    const playing = handle.play()
    await new Promise(r => setTimeout(r, 150))
    handle.stop()
    await playing
    const breakpoint = handle.currentTime
    expect(breakpoint).toBeGreaterThan(0)
    expect(breakpoint).toBeLessThan(handle.duration)
    await handle.play() // 从断点继续
    expect(handle.currentTime).toBe(handle.duration)
  })

  it('seeks within the line and reset returns to zero', async () => {
    const handle = makeSilenceHandle('一二三四五六七八九十')
    handle.seek(1)
    expect(handle.currentTime).toBe(1)
    handle.reset()
    expect(handle.currentTime).toBe(0)
  })
})

describe('makeAudioHandle', () => {
  it('falls back to a silence handle when the audio is empty', () => {
    const handle = makeAudioHandle('', { lineId: 'a', text: '一二三四' })
    expect(handle.url).toBeNull()
    expect(handle.duration).toBe(1.2)
  })
})

describe('browser synthesizer', () => {
  it('rejects when speechSynthesis is unavailable', async () => {
    if (supportsSpeechSynthesis()) return // 真浏览器环境跳过
    const synth = createBrowserSynthesizer()
    await expect(synth.synthesizeBatch([line('a')])).rejects.toMatchObject({ name: 'SynthesizeError' })
  })
})

describe('composite synthesizer', () => {
  it('delegates to the fallback when the primary batch fails', async () => {
    const fallback = vi.fn(() => Promise.resolve(new Map<string, AudioHandle>([['a', makeSilenceHandle('一')]])))
    const composite = createCompositeSynthesizer(
      { synthesizeBatch: () => Promise.reject(new Error('backend down')) },
      { synthesizeBatch: fallback as unknown as TtsSynthesizer['synthesizeBatch'] },
    )
    const out = await composite.synthesizeBatch([line('a')])
    expect(fallback).toHaveBeenCalled()
    expect(out.has('a')).toBe(true)
  })

  it('delegates to the fallback when the primary returns an empty batch', async () => {
    const fallback = vi.fn(() => Promise.resolve(new Map<string, AudioHandle>([['a', makeSilenceHandle('一')]])))
    const composite = createCompositeSynthesizer(
      { synthesizeBatch: () => Promise.resolve(new Map()) },
      { synthesizeBatch: fallback as unknown as TtsSynthesizer['synthesizeBatch'] },
    )
    const out = await composite.synthesizeBatch([line('a')])
    expect(out.has('a')).toBe(true)
  })

  it('prefers the primary when it succeeds', async () => {
    const primary = vi.fn(() => Promise.resolve(new Map<string, AudioHandle>([['a', makeSilenceHandle('一')]])))
    const fallback = vi.fn(() => Promise.resolve(new Map<string, AudioHandle>()))
    const composite = createCompositeSynthesizer(
      { synthesizeBatch: primary as unknown as TtsSynthesizer['synthesizeBatch'] },
      { synthesizeBatch: fallback as unknown as TtsSynthesizer['synthesizeBatch'] },
    )
    await composite.synthesizeBatch([line('a')])
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe('batch synthesizer adapter', () => {
  it('maps backend audios by lineId and retries once on failure', async () => {
    let calls = 0
    const synth = createBatchSynthesizer(async () => {
      calls++
      if (calls === 1) throw new Error('flaky')
      return [{ lineId: 'a', audio: '' }] // 空 audio → 静音兜底
    })
    const out = await synth.synthesizeBatch([line('a')])
    expect(calls).toBe(2)
    expect(out.get('a')!.duration).toBe(1.2)
  })

  it('maps audios without lineId positionally to the requested lines', async () => {
    const synth = createBatchSynthesizer(async () => [{ audio: '' }, { lineId: 'b', audio: '' }])
    const out = await synth.synthesizeBatch([line('a'), line('b')])
    expect([...out.keys()]).toEqual(['a', 'b'])
  })

  it('keys handles by requested lines, ignoring server-side ids', async () => {
    // 请求未下发 lineId：服务端回条目即便带自己的 ID 也必须忽略，否则播放器永远 miss
    const synth = createBatchSynthesizer(async () => [
      { lineId: 'srv-1', audio: '' },
      { lineId: 'srv-2', audio: '' },
    ])
    const out = await synth.synthesizeBatch([line('a'), line('b')])
    expect([...out.keys()]).toEqual(['a', 'b'])
  })

  it('throws after exhausting retries', async () => {
    const synth = createBatchSynthesizer(async () => { throw new Error('down') })
    await expect(synth.synthesizeBatch([line('a')])).rejects.toThrow('down')
  })
})

describe('browser synthesizer', () => {
  it('speaks with zh-CN lang and prefers a Chinese voice', async () => {
    const spoken: Array<{ lang: string, voice: { name: string } | null, text: string }> = []
    class FakeUtterance {
      lang = ''
      rate = 1
      voice: { lang: string, name: string } | null = null
      onend: (() => void) | null = null
      constructor (public text: string) { spoken.push(this) }
    }
    const speechSynthesis = {
      getVoices: () => [{ lang: 'en-US', name: 'English' }, { lang: 'zh-CN', name: 'Huihui' }] as unknown as SpeechSynthesisVoice[],
      speak: (u: unknown) => { setTimeout(() => (u as FakeUtterance).onend?.(), 0) },
      cancel: () => {},
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speechSynthesis })
    ;(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance
    try {
      const synth = createBrowserSynthesizer()
      const handle = (await synth.synthesizeBatch([line('a', '你好，充电站。')])).get('a')!
      await handle.play()
      expect(spoken[0].lang).toBe('zh-CN')
      expect(spoken[0].voice?.name).toBe('Huihui')
    } finally {
      delete (globalThis as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis
      spoken.length = 0
    }
  })
})
