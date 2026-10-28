import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useExplainPlayer } from './useExplainPlayer'
import type { ExplainController, ExplainStateSnapshot } from '../core/ExplainController'

describe('continuous answer timeline', () => {
  it('shows elapsed time before duration is ready and preserves paused state when seeking', async () => {
    const snapshot = ref({ phase: 'answering', answerStatus: 'paused', currentTime: 17, duration: 17,
      answerPlayback: { groupId: 'g1', currentTime: 13, duration: 0, ready: false }, lines: [],
    } as unknown as ExplainStateSnapshot)
    const controller = { play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setRate: vi.fn() }
    const view = useExplainPlayer(snapshot, ref(controller as unknown as ExplainController))
    expect(view.clock.value).toBe('00:13')
    expect(view.timelineReady.value).toBe(false)
    await view.seekTo(20)
    expect(controller.seekTo).not.toHaveBeenCalled()
    snapshot.value.answerPlayback = { groupId: 'g1', currentTime: 13, duration: 30, ready: true }
    expect(view.ratio.value).toBeCloseTo(13 / 30)
    await view.seekTo(20)
    expect(controller.seekTo).toHaveBeenCalledWith(20)
    expect(controller.play).not.toHaveBeenCalled()
    expect(controller.pause).not.toHaveBeenCalled()
    snapshot.value.answerPlayback = null
    expect(view.clock.value).toBe('00:17')
    expect(view.duration.value).toBe(17)
  })
})
