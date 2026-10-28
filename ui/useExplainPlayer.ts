/**
 * 讲解播放器视图桥（composable，移植自 feature/large-screen useBroadcastPlayer.js）
 * ----------------------------------------------------------------------
 * 大屏版桥的是 DialoguePlayer 实例；本组件桥的是 headless 控制器的状态快照
 * （控制器已把 onProgress 节流成 ~15Hz 快照）。保留两个关键行为：
 *  - 拖拽：播放头读数在本层合成（isScrubbing ? scrubSec : 快照 currentTime），
 *    拖动过程中真实播放照常推进、指针不被"拽回"，松手才落一次真 seek
 *  - 倍速是用户偏好：换脚本/重播不重置
 */
import { computed, ref, type Ref } from 'vue'
import type { ExplainStateSnapshot } from '../core/ExplainController'
import type { ExplainController } from '../core/ExplainController'
import { formatClock } from './themes'

export const BROADCAST_RATE_STEPS = [0.75, 1, 1.25, 1.5, 2]
/** 快进快退步长（媒体秒），来自大屏播报约定 */
export const BROADCAST_SKIP_SEC = 15

export function useExplainPlayer (snapshot: Ref<ExplainStateSnapshot | null>, bot: Ref<ExplainController | null>) {
  const isScrubbing = ref(false)
  const scrubSec = ref(0)
  const rate = ref(1)

  const answerTimeline = computed(() => snapshot.value?.answerPlayback || null)
  const timelineReady = computed(() => !answerTimeline.value || answerTimeline.value.ready)
  const duration = computed(() => answerTimeline.value ? answerTimeline.value.duration : snapshot.value?.duration || 0)
  /** 进度条/时间文字显示的媒体秒 */
  const displayTime = computed(() => (isScrubbing.value ? scrubSec.value : answerTimeline.value?.currentTime ?? snapshot.value?.currentTime ?? 0))
  const ratio = computed(() => (duration.value > 0 ? Math.min(1, Math.max(0, displayTime.value / duration.value)) : 0))
  /** 当前是否已到末尾附近（决定播放键是"继续"还是"重播"） */
  const atEnd = computed(() => duration.value > 0 && displayTime.value >= duration.value - 0.2)
  const clock = computed(() => formatClock(displayTime.value))
  const totalClock = computed(() => formatClock(duration.value))
  /** 每行起点时间戳（mm:ss），随时长校准（version 快照整体更新）重算 */
  const lineStamps = computed(() => (snapshot.value?.lineStarts || []).map(start => formatClock(start)))

  /** 定位到某媒体秒（进度条落点、±15 秒共用入口）；播放极性沿用当前 phase */
  async function seekTo (sec: number) {
    const controller = bot.value
    if (!controller || !snapshot.value || !timelineReady.value) return
    if (!answerTimeline.value && !snapshot.value.lines.length) return
    const target = Math.max(0, Math.min(Number(sec) || 0, duration.value))
    const resume = snapshot.value.phase !== 'paused'
    isScrubbing.value = false
    if (!answerTimeline.value) { if (resume) controller.play(); else controller.pause() }
    await controller.seekTo(target)
  }

  /** 相对当前显示位置进退（±15 秒按钮） */
  function seekBy (deltaSec: number) {
    return seekTo(displayTime.value + (Number(deltaSec) || 0))
  }

  /** 拖拽开始/进行（只改本地预览值，不落真 seek） */
  function beginScrub (sec: number) {
    isScrubbing.value = true
    scrubSec.value = Math.max(0, Math.min(Number(sec) || 0, duration.value))
  }
  function updateScrub (sec: number) {
    if (!isScrubbing.value) return
    scrubSec.value = Math.max(0, Math.min(Number(sec) || 0, duration.value))
  }
  /** 松手：落到真实 seek */
  function endScrub (sec?: number) {
    if (!isScrubbing.value) return
    if (sec != null) scrubSec.value = Math.max(0, Math.min(Number(sec) || 0, duration.value))
    return seekTo(scrubSec.value)
  }
  /** 放弃拖拽（面板关闭/脚本切换时调用，不落 seek） */
  function cancelScrub () {
    isScrubbing.value = false
    scrubSec.value = 0
  }

  function applyRate (next: number) {
    const value = Number(next)
    if (!(value > 0)) return
    rate.value = value
    bot.value?.setRate(value)
  }
  /** 点击倍速钮：档位循环 */
  function cycleRate () {
    const i = BROADCAST_RATE_STEPS.indexOf(rate.value)
    applyRate(BROADCAST_RATE_STEPS[(i + 1) % BROADCAST_RATE_STEPS.length])
  }

  return {
    rate, isScrubbing, scrubSec,
    duration, displayTime, ratio, atEnd, clock, totalClock, lineStamps, timelineReady, answerTimeline,
    seekTo, seekBy,
    beginScrub, updateScrub, endScrub, cancelScrub,
    applyRate, cycleRate,
    skipSec: BROADCAST_SKIP_SEC,
  }
}
