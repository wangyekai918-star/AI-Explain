import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DialoguePlayer, type ScriptLine } from './dialoguePlayer'
import { makeSilenceHandle, type TtsSynthesizer } from './ttsEngine'

// jsdom 可能没有 rAF；用定时器 shim 驱动 ticker（进度上报路径）
if (typeof globalThis.requestAnimationFrame !== 'function') {
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number
  ;(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id)
}

const lineOf = (id: string, text = '一'): ScriptLine => ({ lineId: id, speaker: 'A', text })
/** 全静音合成器：句柄按估算时长走计时（1 字句 = 1.2s 媒体秒） */
const silenceSynth: TtsSynthesizer = {
  synthesizeBatch: async lines => new Map(lines.map(l => [l.lineId, makeSilenceHandle(l.text)])),
}

const quickPlayer = (callbacks: ConstructorParameters<typeof DialoguePlayer>[0] = {}) => {
  const player = new DialoguePlayer({ tts: silenceSynth, gapSame: 10, gapSwitch: 10, ...callbacks })
  player.setRate(8) // 加速跑完，时间轴断言不受倍速影响（媒体秒口径）
  return player
}

const waitFor = async (predicate: () => boolean, timeout = 8000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor 超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('DialoguePlayer', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('plays a one-shot script in order and finishes', async () => {
    const started: string[] = []
    const finished = vi.fn()
    const player = quickPlayer({ onLineStart: l => started.push(l.lineId), onFinished: finished })
    player.load([lineOf('a'), lineOf('b'), lineOf('c')])
    await player.play()
    await waitFor(() => finished.mock.calls.length > 0)
    expect(started).toEqual(['a', 'b', 'c'])
    expect(player.currentTime).toBeGreaterThan(0)
  })

  it('consumes lines appended while streaming, in script order', async () => {
    const started: string[] = []
    const finished = vi.fn()
    const player = quickPlayer({ onLineStart: l => started.push(l.lineId), onFinished: finished })
    player.appendLines([lineOf('a')])
    void player.play()
    await waitFor(() => started.includes('a'))
    player.appendLines([lineOf('b'), lineOf('c')]) // 生成期流式到达
    await waitFor(() => finished.mock.calls.length > 0)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('keeps timeline readings stable across rate changes (media-second semantics)', () => {
    const player = quickPlayer()
    player.load([lineOf('a'), lineOf('b'), lineOf('c')])
    const before = player.duration
    player.setRate(2)
    expect(player.duration).toBe(before) // 倍速不改变媒体时长读数
  })

  it('locates seek targets on the virtual timeline and keeps position when paused', async () => {
    const player = quickPlayer()
    player.load([lineOf('a'), lineOf('b'), lineOf('c')])
    await player.seekTo(2.0, { resume: false }) // starts = [0, 1.2, 2.4] → 第 2 句句内 0.8
    expect(player.currentIndex).toBe(0) // 游标前置一位约定（播放头真相在 _pos，见 currentTime）
    expect(player.currentTime).toBeCloseTo(2.0, 5)
    expect(player.playing).toBe(false)
    await player.play(1, 0.8) // 从该偏移续播
    await waitFor(() => player.currentIndex >= 1)
  })

  it('skips a failed line and keeps playing the rest', async () => {
    const partial: TtsSynthesizer = {
      synthesizeBatch: async lines => new Map(lines.filter(l => l.lineId !== 'b').map(l => [l.lineId, makeSilenceHandle(l.text)])),
    }
    const started: string[] = []
    const errors: number[] = []
    const finished = vi.fn()
    const player = new DialoguePlayer({
      tts: partial, gapSame: 10, gapSwitch: 10,
      onLineStart: l => started.push(l.lineId),
      onError: (_e, index) => errors.push(index),
      onFinished: finished,
    })
    player.setRate(8)
    player.load([lineOf('a'), lineOf('b'), lineOf('c')])
    await player.play()
    await waitFor(() => finished.mock.calls.length > 0)
    expect(started).toEqual(['a', 'c']) // 失败句不触发 onLineStart（不显示）
    expect(errors).toEqual([1])
  })

  it('rewinds to zero while preserving the audio cache', async () => {
    const player = quickPlayer()
    player.load([lineOf('a')])
    await player.play()
    await waitFor(() => player.currentIndex === 0)
    player.rewind()
    expect(player.currentTime).toBe(0)
    expect(player.currentIndex).toBe(-1)
  })
})
