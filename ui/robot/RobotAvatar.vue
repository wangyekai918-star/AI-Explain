<template>
  <span class="aeb-ip-avatar" :data-state="state" aria-hidden="true" :style="containerStyle">
    <img :src="bottom" alt="" :style="imageStyle(1)" />
    <span :style="eyesStyle"><span :style="slotStyle">
      <iframe ref="frame" title="AI 机器人眼睛动画" :srcdoc="eyeDocument" tabindex="-1" aria-hidden="true"
        :style="frameStyle" @load="onLoad" />
    </span></span>
    <img :src="top" alt="" :style="imageStyle(3)" />
  </span>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import type { RobotVisualState } from './useRobotVisualState'
import eyeDocument from './eyes-engine.html?raw'
import top from './assets/外壳-上层.png?inline'
import bottom from './assets/外壳-底层.png?inline'
import outerMask from './assets/头部外轮廓.png?inline'

const props = withDefaults(defineProps<{ state: RobotVisualState; revision?: number; idleEnabled?: boolean }>(), { idleEnabled: true, revision: 0 })
const emit = defineEmits<{ (e: 'action-complete'): void }>()
const frame = ref<HTMLIFrameElement | null>(null)
type EyeWindow = Window & { applyEmotion?: (action: string) => Promise<unknown> | void; dispose?: () => void }
let ready = false
let sequence = 0
let disposed = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
let sleeping = false
function clearIdleTimer() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null }
function isCurrent(token: number) { return !disposed && token === sequence }
function api() { return frame.value?.contentWindow as EyeWindow | null }
async function play(action: string) { await api()?.applyEmotion?.(action) }
function scheduleIdle(token: number) {
  if (!isCurrent(token) || props.state !== 'idle' || props.idleEnabled === false) return
  idleTimer = setTimeout(() => { void nextIdle(token) }, sleeping ? 4500 + Math.random()*3500 : 6000 + Math.random()*6000)
}
async function nextIdle(token: number) {
  if (!isCurrent(token) || props.state !== 'idle' || props.idleEnabled === false) return
  // Wake is only entered from sleep; never jump directly from closed to idle.
  const action = sleeping ? 'wake' : Math.random()<.25 ? 'sleep' : Math.random()<.55 ? 'bored' : 'idle'
  await play(action)
  if (!isCurrent(token)) return
  sleeping = action === 'sleep'
  scheduleIdle(token)
}
async function applyState() {
  const token = ++sequence
  clearIdleTimer()
  if (!ready || disposed) return
  const state = props.state
  try {
    if (state === 'idle') {
      await play(sleeping ? 'wake' : 'idle')
      if (!isCurrent(token)) return
      sleeping = false; scheduleIdle(token)
      return
    }
    sleeping = false
    await play(state === 'received' ? 'affirm' : state === 'thinking' ? 'waiting-spin' : state === 'speaking' ? 'waiting-wave' : state)
    if (isCurrent(token) && props.state === state && state !== 'thinking' && state !== 'speaking') emit('action-complete')
  } catch {
    if (isCurrent(token) && state !== 'thinking' && state !== 'speaking' && state !== 'idle') emit('action-complete')
  }
}
function onLoad() { ready = true; void applyState() }
watch(() => [props.state,props.revision,props.idleEnabled], () => { void applyState() })
onBeforeUnmount(() => {
  disposed = true; sequence++; clearIdleTimer(); api()?.dispose?.()
})
// Inline styles also work when the parent is distributed as a Vue custom element.
const containerStyle = { display:'block', position:'relative', width:'100%', height:'100%', isolation:'isolate', colorScheme:'only light', pointerEvents:'none' } as const
const imageStyle = (zIndex: number) => ({ position:'absolute', inset:'0', width:'100%', height:'100%', objectFit:'contain', zIndex, pointerEvents:'none' } as const)
const eyesStyle = { position:'absolute', inset:'0', zIndex:2, maskImage:`url("${outerMask}")`, WebkitMaskImage:`url("${outerMask}")`, maskSize:'100% 100%', WebkitMaskSize:'100% 100%' } as const
const slotStyle = { position:'absolute', left:'12%', top:'27%', width:'76%', height:'43%' } as const
const frameStyle = { display:'block', width:'100%', height:'100%', border:'0', colorScheme:'only light', pointerEvents:'none', background:'transparent' } as const
</script>
