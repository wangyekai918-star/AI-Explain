import { computed, ref, watch, type Ref } from 'vue'
import type { ExplainStateSnapshot } from '../../core/ExplainController'

export type RobotVisualState = 'idle' | 'received' | 'thinking' | 'failure' | 'speaking'

/** UI-only lifecycle, including acknowledgement before a fast/slow answer. */
export function useRobotVisualState(snapshot: Ref<ExplainStateSnapshot | null>) {
  const state = ref<RobotVisualState>('idle')
  const revision = ref(0)
  const isSpeaking = () => !!snapshot.value && snapshot.value.voiceState === 'idle' && (snapshot.value.phase === 'playing' || (snapshot.value.phase === 'answering' && snapshot.value.answerStatus === 'playing'))
  let pending: RobotVisualState = 'thinking'
  const showResult = (next: RobotVisualState) => {
    if (state.value === 'received') pending = next
    else state.value = next
  }
  watch(snapshot, (now, before) => {
    if (!now) { state.value = 'idle'; return }
    const failed = now.phase === 'error' || now.updateFailed || (now.error && now.error !== before?.error)
    if (failed) {
      if (before?.phase !== now.phase || before?.error !== now.error || before?.updateFailed !== now.updateFailed || !before) showResult('failure')
      return
    }
    const newQuestion = now.answerStatus === 'analyzing' && (before?.answerStatus !== 'analyzing'
      || before?.activeGroupId !== now.activeGroupId || before?.questionText !== now.questionText)
    if (newQuestion) {
      pending = 'thinking'; revision.value++; state.value = 'received'; return
    }
    const thinking = ['assembling','generating'].includes(now.phase) || now.answerStatus === 'analyzing'
    if (thinking) {
      if (state.value !== 'received') state.value = 'thinking'
      return
    }
    const mainReady = before && ['assembling','generating'].includes(before.phase)
      && ['interpreting','playing'].includes(now.phase) && now.lines.length > 0
    const answerReady = before?.answerStatus === 'analyzing' && ['playing','paused'].includes(now.answerStatus)
      && (now.answerLines.length > 0 || now.answerText.trim().length > 0)
    if (mainReady || answerReady) showResult(isSpeaking() ? 'speaking' : 'idle')
    else if (state.value === 'thinking' || (state.value === 'received' && pending === 'thinking' && now.answerStatus !== 'analyzing')) state.value = 'idle'
    if (!['received', 'failure'].includes(state.value)) state.value = isSpeaking() ? 'speaking' : state.value === 'speaking' ? 'idle' : state.value
  }, { immediate:true, flush:'sync' })
  const finishAction = () => {
    if (state.value === 'received') state.value = pending
    else if (state.value === 'failure') state.value = isSpeaking() ? 'speaking' : 'idle'
  }
  const idleEnabled = computed(() => !!snapshot.value && ['idle','paused','ended'].includes(snapshot.value.phase) && snapshot.value.voiceState === 'idle' && !['playing','analyzing'].includes(snapshot.value.answerStatus))
  return { state, revision, idleEnabled, finishAction }
}
