<template>
  <div v-if="configReady && !dismissed" class="aeb-root" :data-theme="currentTheme" :class="[`pos-${currentPosition}`, { 'is-neutral': !accentColor, 'has-conversation': dialogGroups.length > 0, 'is-speaking': playing || answerStatus === 'playing', 'is-listening': voiceState === 'recording', 'is-thinking': phase === 'generating' || answerStatus === 'analyzing' }]" :style="robotStyle">
    <!-- 形象入口（idle/未展开）：配置就绪后才显示，避免配置到达换图/换位的瞬时跳变；show-avatar="false" 时整体不渲染。
         wrapper 内含关闭角标；可拖时拖拽把整体转 fixed 跟手，播放器（迷你浮层/面板）仍按配置 position 停靠 -->
    <div v-if="showAvatarEnabled && !panelOpen" class="aeb-avatar-wrap" :style="avatarWrapStyle">
      <button
        part="avatar"
        class="aeb-avatar"
        :class="{ 'aeb-draggable': avatarDraggableEnabled, 'aeb-avatar-ip': !avatarSrc }"
        :style="avatarStyle"
        aria-label="发起 AI 讲解"
        @pointerdown="onAvatarPointerDown"
        @click="onAvatarClick"
        @dragstart.prevent
      >
        <img v-if="avatarSrc" :src="avatarSrc" alt="" />
        <RobotAvatar v-else :state="robotVisualState" :revision="robotVisualRevision" :idle-enabled="robotIdleEnabled" @action-complete="finishRobotAction" />
        <img v-if="!avatarSrc" class="aeb-avatar-label" :src="avatarLabel" alt="" aria-hidden="true" />
      </button>
      <button part="avatar-close" class="aeb-avatar-close" aria-label="关闭 AI 讲解" @click.stop="dismiss"><X :size="12" /></button>
    </div>

    <!-- 缩起迷你浮层 -->
    <section v-else-if="!expanded" part="mini-panel" class="aeb-mini">
      <span class="aeb-header-avatar" :class="{ 'aeb-header-avatar-ip': !avatarSrc }" aria-hidden="true"><img v-if="avatarSrc" :src="avatarSrc" alt="" /><RobotAvatar v-else :state="robotVisualState" :revision="robotVisualRevision" :idle-enabled="robotIdleEnabled" @action-complete="finishRobotAction" /></span>
      <div class="aeb-mini-copy">
        <div class="aeb-mini-title">AI 讲解 · {{ currentScenarioName }}</div>
        <div class="aeb-mini-detail">
          <span class="aeb-mini-state" role="status"><LoaderCircle v-if="preparing || snap?.updating || answering" :size="12" class="aeb-loading" />{{ statusText }}</span>
          <button v-if="snap?.updateFailed" class="aeb-retry" @click="botRef.retryRefresh()">重试</button>
          <span v-else-if="miniPreview" class="aeb-mini-preview" :title="miniPreview">{{ miniPreview }}</span>
        </div>
      </div>
      <div v-if="!voiceBusy" class="aeb-capsule-controls">
        <button class="aeb-btn aeb-capsule-play" :aria-label="playing ? '暂停' : '播放'" :title="playing ? '暂停讲解' : '播放讲解'" :disabled="!playControlReady" :aria-busy="playLoading" @click="togglePlay"><LoaderCircle v-if="playLoading" :size="17" class="aeb-loading" aria-hidden="true" /><Pause v-else-if="playing" :size="17" fill="currentColor" /><Play v-else :size="17" fill="currentColor" /></button>
        <button v-if="canInterrupt" part="voice-mini" class="aeb-btn aeb-mic aeb-mic-mini" :disabled="!askReady" aria-label="点击说话" title="点击说话" @click="startClickVoice"><Mic :size="17" /></button>
        <button class="aeb-btn aeb-mini-rate" aria-label="倍速" :disabled="!controlReady" @click="cycleRate">{{ rate }}×</button>
      </div>
      <div v-if="voiceBusy" class="aeb-recording-bar aeb-voice-capsule" part="recording-bar" role="group" aria-label="语音录音控制">
        <button v-if="voiceStarting || (voiceState === 'recording' && !voiceFinishing)" class="aeb-record-cancel" :disabled="voiceCancelRequested" aria-label="取消录音" title="取消录音（Esc）" @click="cancelClickVoice"><X :size="18" /></button>
        <div v-if="voiceState === 'recording' && !voiceStarting && !voiceFinishing" class="aeb-waveform" role="img" :aria-label="`正在录音 ${recordingClock}`">
          <span v-for="(level, i) in waveformLevels" :key="i" :style="{ height: `${3 + level * 22}px` }" />
        </div>
        <div v-else class="aeb-recording-info" role="status" aria-live="polite"><LoaderCircle :size="15" class="aeb-loading" aria-hidden="true" /><span>{{ voiceStarting ? (voiceCancelRequested ? '已取消，等待麦克风就绪…' : '正在准备麦克风…') : '正在识别语音…' }}</span></div>
        <button v-if="voiceState === 'recording' && !voiceStarting && !voiceFinishing" class="aeb-record-finish" :aria-label="expanded && voiceSendMode === 'fill' ? '结束录音' : '结束并发送'" :title="expanded && voiceSendMode === 'fill' ? '结束录音，识别后回填' : '结束录音并发送'" @click="finishClickVoice"><Check :size="19" /></button>
      </div>
      <button class="aeb-icon" aria-label="展开" title="展开对话" @click="setPanelMode(true)"><Maximize2 :size="16" /></button>
      <button class="aeb-icon" aria-label="关闭" title="关闭" @click="close"><X :size="17" /></button>
    </section>

    <!-- 展开字幕面板 -->
    <section v-else v-smooth-height part="panel" class="aeb-panel">
      <div class="aeb-panel-content">
      <header class="aeb-row aeb-panel-header" part="panel-header">
        <span class="aeb-header-avatar" :class="{ 'aeb-header-avatar-ip': !avatarSrc }" aria-hidden="true"><img v-if="avatarSrc" :src="avatarSrc" alt="" /><RobotAvatar v-else :state="robotVisualState" :revision="robotVisualRevision" :idle-enabled="robotIdleEnabled" @action-complete="finishRobotAction" /></span>
        <div class="aeb-heading"><span class="aeb-title">AI 讲解 · {{ currentScenarioName }}</span><span class="aeb-heading-status" role="status">{{ statusText }}<button v-if="snap?.updateFailed" class="aeb-retry" @click="botRef.retryRefresh()">重试</button></span></div>
        <button class="aeb-icon" aria-label="收起" @click="setPanelMode(false)"><Minimize2 :size="16" /></button>
        <button class="aeb-icon" aria-label="关闭" @click="close"><X :size="17" /></button>
      </header>

      <div
        v-show="subtitleVisible && hasPanelContent"
        ref="subtitleBox"
        class="aeb-subtitles"
        part="subtitle-list"
        @wheel="pauseFollow"
        @pointerdown="pauseFollow"
        @touchstart.passive="pauseFollow"
        @scroll="onSubtitleScroll"
      >
        <section v-for="(context, index) in snap?.contextHistory || []" :key="index" class="aeb-history">
          <p class="aeb-context-divider">{{ context.label }}</p>
          <p v-for="line in context.lines" :key="line.lineId" class="aeb-history-line">{{ line.text }}</p>
          <div v-for="group in context.groups" :key="group.id" class="aeb-dialog-group">
            <div class="aeb-user-message"><span class="aeb-group-q">{{ group.question }}</span></div>
            <div class="aeb-ai-bubble"><p v-for="line in group.lines" :key="line.lineId" class="aeb-line aeb-answerline">{{ line.text }}</p></div>
          </div>
        </section>
        <p v-if="snap?.sourceLabel" class="aeb-context-divider">已切换至 {{ snap.sourceLabel }}</p>
        <p
          v-for="(line, i) in lines"
          :key="line.lineId"
          class="aeb-line aeb-playable-line"
          role="button" :tabindex="bubblePlaybackReady ? 0 : -1" :aria-disabled="!bubblePlaybackReady"
          :aria-label="`播放这段讲解：${line.text}`" title="点击播放这段讲解"
          @click="playBubble(i)" @keydown.enter.prevent="playBubble(i)" @keydown.space.prevent="playBubble(i)"
          :class="[`aeb-speaker-${line.speaker}`, { 'aeb-active': i === currentLineIndex && answerLineIndex < 0, 'aeb-past': i < currentLineIndex }]"
        >
          <span class="aeb-speaker aeb-sr-only">AI · {{ speakerName(line.speaker) }}</span>
          <span class="aeb-text">{{ line.text }}</span>
        </p>

        <!-- 每组是一条用户消息和一段 AI 回答，点击回答气泡播放。 -->
        <section v-for="g in dialogGroups" :key="g.id" class="aeb-dialog-group" part="dialog-group">
          <header class="aeb-group-head aeb-user-message">
            <span class="aeb-user-meta aeb-sr-only"><span class="aeb-group-src" :aria-label="g.source === 'voice' ? '语音提问' : '文字提问'" role="img"><Mic v-if="g.source === 'voice'" :size="12" /><MessageCircle v-else :size="12" /></span>我</span>
            <span class="aeb-group-q" :title="g.question">{{ g.question }}</span>
          </header>
          <div class="aeb-ai-message">
            <div class="aeb-ai-bubble aeb-playable-answer"
              :class="{ 'aeb-answer-active': g.id === activeGroupId && answerLineIndex >= 0 }"
              role="button" :tabindex="bubblePlaybackReady && (g.done || g.id === activeGroupId) ? 0 : -1" :aria-disabled="!bubblePlaybackReady || (!g.done && g.id !== activeGroupId)"
              aria-label="播放这条回答" title="点击播放这条回答"
              @click="playAnswerBubble(g.id, g.done)" @keydown.enter.prevent="playAnswerBubble(g.id, g.done)" @keydown.space.prevent="playAnswerBubble(g.id, g.done)">
              <p v-for="(line, i) in g.lines" :key="line.lineId" class="aeb-line aeb-answerline" part="answer-line"
                :class="[`aeb-speaker-${line.speaker}`, { 'aeb-active': g.id === activeGroupId && i === answerLineIndex }]">
                <span class="aeb-speaker aeb-sr-only">AI · {{ speakerName(line.speaker) }}</span>
                <span class="aeb-text">{{ line.text }}</span>
              </p>
              <p v-if="g.id === activeGroupId && answering && !g.lines.length" class="aeb-answer-pending" role="status"><LoaderCircle :size="13" class="aeb-loading" />{{ answerStatus === 'analyzing' ? '正在思考…' : '正在组织回答…' }}</p>
            </div>

          </div>
        </section>
      </div>

      <div
        v-show="timelineVisible && timelineReady"
        ref="progressEl"
        class="aeb-progress"
        part="progress"
        @pointerdown="onProgressDown"
        @pointermove="onProgressMove"
        @pointerup="onProgressUp"
        @pointercancel="onProgressUp"
      >
        <div class="aeb-ratio" :style="{ width: `${ratio * 100}%` }" />
        <!-- 问答打断点标记:每组追问在主轨上的发生位置,点击跳转该断点 -->
        <span
          v-for="(g, i) in progressMarkers"
          v-show="!isScrubbing && !answerTimeline"
          :key="g.id"
          class="aeb-progress-marker"
          :style="{ left: `${(g.breakpoint / duration) * 100}%` }"
          :title="g.question"
          @pointerdown.stop
          @click.stop="seekToMarker(g)"
        >{{ i + 1 }}</span>
      </div>
      <div v-show="timelineVisible" class="aeb-clockrow"><span>{{ clock }}</span><span v-if="timelineReady">{{ totalClock }}</span></div>

      <div class="aeb-controls" part="controls">
        <button class="aeb-btn aeb-sub" :class="{ 'aeb-off': !subtitleVisible }" aria-label="字幕开关" :aria-pressed="subtitleVisible" :title="subtitleVisible ? '隐藏字幕' : '显示字幕'" @click="subtitleVisible = !subtitleVisible">字幕</button>
        <button class="aeb-btn" aria-label="快退" :title="`快退 ${skipSec} 秒`" :disabled="!controlReady" @click="seekBy(-skipSec)"><svg width="20" height="20" aria-hidden="true" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M16.0006 63.9841C16.038 85.9041 31.174 105.675 53.462 110.693C61.8138 112.573 70.5164 112.184 78.6676 109.569C86.8188 106.953 94.1222 102.204 99.8206 95.8157C105.519 89.4272 109.405 81.6309 111.076 73.2349C112.748 64.8389 112.143 56.1487 109.325 48.065C106.507 39.9813 101.579 32.7984 95.0508 27.2605C88.5225 21.7227 80.632 18.0315 72.197 16.5696C63.7621 15.1076 55.0896 15.9281 47.0785 18.9461C39.0674 21.964 32.0091 27.0695 26.6353 33.7334L29.334 10.6667L32.0166 24.0107" stroke-width="10.667" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/>
<path d="M84.0693 45.3335H65.4027V61.6695C65.4027 61.6695 70.0693 59.3335 74.736 59.3335C81.7387 59.3335 86.4053 64.5602 86.4053 71.0028C86.4088 73.6856 85.4874 76.2876 83.7963 78.3703C82.1052 80.453 79.7478 81.8891 77.1215 82.4365C74.4951 82.984 71.7603 82.6093 69.378 81.3757C66.9956 80.1421 65.1113 78.1249 64.0427 75.6642M40 50.6668L48 45.3335V82.6668" stroke-width="10.667" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/>
</svg></button>
        <button class="aeb-btn aeb-play" :title="playing ? '暂停讲解' : atEnd ? '重新播放' : '播放讲解'" :aria-label="playing ? '暂停' : '播放'" :disabled="!playControlReady" :aria-busy="playLoading" @click="togglePlay"><LoaderCircle v-if="playLoading" :size="19" class="aeb-loading" aria-hidden="true" /><Pause v-else-if="playing" :size="19" fill="currentColor" /><Play v-else :size="19" fill="currentColor" /></button>
        <button class="aeb-btn" aria-label="快进" :title="`快进 ${skipSec} 秒`" :disabled="!controlReady" @click="seekBy(skipSec)"><svg width="20" height="20" aria-hidden="true" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M112 63.9841C111.963 85.9041 96.8268 105.675 74.5388 110.693C66.1869 112.573 57.4844 112.184 49.3331 109.569C41.1819 106.953 33.8786 102.204 28.1801 95.8157C22.4817 89.4272 18.5955 81.6309 16.9243 73.2349C15.2531 64.8389 15.8577 56.1487 18.6755 48.065C21.4933 39.9813 26.4217 32.7984 32.95 27.2605C39.4782 21.7227 47.3687 18.0315 55.8037 16.5696C64.2387 15.1076 72.9111 15.9281 80.9223 18.9461C88.9334 21.964 95.9916 27.0695 101.365 33.7334L98.6668 10.6667L95.9841 24.0107M84.0694 45.3334H65.4028V61.6694C65.4028 61.6694 70.0694 59.3334 74.7361 59.3334C81.7388 59.3334 86.4054 64.5601 86.4054 71.0027C86.4089 73.6856 85.4875 76.2875 83.7964 78.3702C82.1053 80.4529 79.7479 81.889 77.1216 82.4365C74.4952 82.9839 71.7604 82.6092 69.3781 81.3756C66.9957 80.142 65.1114 78.1249 64.0428 75.6641M40.0001 50.6667L48.0001 45.3334V82.6667" stroke-width="10.667" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/>
</svg></button>
        <button class="aeb-btn" aria-label="倍速" :disabled="!controlReady" @click="cycleRate">{{ rate }}×</button>
      </div>

      <div v-if="voiceBusy" class="aeb-recording-bar aeb-voice-capsule" part="recording-bar" role="group" aria-label="语音录音控制">
        <button v-if="voiceStarting || (voiceState === 'recording' && !voiceFinishing)" class="aeb-record-cancel" :disabled="voiceCancelRequested" aria-label="取消录音" title="取消录音（Esc）" @click="cancelClickVoice"><X :size="18" /></button>
        <div v-if="voiceState === 'recording' && !voiceStarting && !voiceFinishing" class="aeb-waveform" role="img" :aria-label="`正在录音 ${recordingClock}`">
          <span v-for="(level, i) in waveformLevels" :key="i" :style="{ height: `${3 + level * 22}px` }" />
        </div>
        <div v-else class="aeb-recording-info" role="status" aria-live="polite"><LoaderCircle :size="15" class="aeb-loading" aria-hidden="true" /><span>{{ voiceStarting ? (voiceCancelRequested ? '已取消，等待麦克风就绪…' : '正在准备麦克风…') : '正在识别语音…' }}</span></div>
        <button v-if="voiceState === 'recording' && !voiceStarting && !voiceFinishing" class="aeb-record-finish" :aria-label="expanded && voiceSendMode === 'fill' ? '结束录音' : '结束并发送'" :title="expanded && voiceSendMode === 'fill' ? '结束录音，识别后回填' : '结束录音并发送'" @click="finishClickVoice"><Check :size="19" /></button>
      </div>
      <footer v-if="canInterrupt && !voiceBusy" class="aeb-ask" part="ask-bar">
        <input
          v-model="askInput"
          class="aeb-input"
          :placeholder="voiceState === 'recording' ? '正在聆听，请说话…' : '向 AI 提问'"
          :disabled="!askReady"
          @keydown.enter="submitAsk"
        />
        <button part="voice" class="aeb-mic aeb-click-mic" :disabled="!askReady"
          aria-label="点击说话" title="点击说话" @click="startClickVoice"><Mic :size="18" /></button>
        <button class="aeb-send" :disabled="!askReady || !askInput.trim()" @click="submitAsk" aria-label="发送"><ArrowUp :size="19" /><span class="aeb-sr-only">发送</span></button>
      </footer>
      </div>
    </section>

    <p v-if="errorToast" class="aeb-error" part="error" role="alert">{{ ERROR_TOAST_TEXT }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X, Maximize2, Minimize2, Play, Pause, ArrowUp, MessageCircle, Check, LoaderCircle } from '@lucide/vue'
import { createExplainController, type ExplainController, type ExplainStateSnapshot } from '../core/ExplainController'
import { ExplainServiceClient, type ExplainTransport } from '../core/explainServiceClient'
import { RestTeldHubSessionRepository, deriveBaseUrlFromLocation } from '../core/rest/RestTeldHubSessionRepository'
import {
  createBatchSynthesizer,
  createBrowserSynthesizer,
  createCompositeSynthesizer,
  type TtsSynthesizer,
} from '../core/ttsEngine'
import type { DataSourceUpdate } from '../core/ExplainController'
import type { ScriptLine } from '../core/dialoguePlayer'
import { SPEAKER_META } from '../core/ttsEngine'
import { themeFromColor, themeTokens, type ExplainTheme } from './themes'
import { useExplainPlayer } from './useExplainPlayer'
import RobotAvatar from './robot/RobotAvatar.vue'
import Mic from './MicrophoneIcon.vue'
import avatarLabel from './robot/assets/AI讲解标签.png?inline'
import { useRobotVisualState } from './robot/useRobotVisualState'

// Animate the shell while observing its natural-sized content, so rapid updates
// continue from the currently displayed height instead of restarting at the old size.
const panelHeightEffects = new WeakMap<HTMLElement, () => void>()
const vSmoothHeight = {
  mounted(el: HTMLElement) {
    if (typeof ResizeObserver === 'undefined') return
    const content = el.firstElementChild as HTMLElement
    let target = content.getBoundingClientRect().height
    let effect: Animation | null = null
    const observer = new ResizeObserver(() => {
      const next = content.getBoundingClientRect().height
      if (Math.abs(next - target) < .5) return
      const border = el.offsetHeight - el.clientHeight
      const from = effect?.playState === 'running' ? el.getBoundingClientRect().height : target + border
      target = next
      effect?.cancel()
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !el.animate) return
      effect = el.animate([{ height: `${from}px` }, { height: `${next + border}px` }], {
        duration: 300, easing: 'cubic-bezier(.22,1,.36,1)',
      })
    })
    observer.observe(content)
    panelHeightEffects.set(el, () => { observer.disconnect(); effect?.cancel() })
  },
  beforeUnmount(el: HTMLElement) { panelHeightEffects.get(el)?.(); panelHeightEffects.delete(el) },
}

const props = withDefaults(defineProps<{
  /** 对接配置 ID（讲解场景，必填才可发起） */
  configId?: string
  /** MD 查询参数（data_access_type=1），JSON 字符串 */
  mdSearchParam?: string
  scenarioName?: string
  /** WorkHub 网关基址；缺省按页面域名推导 as.<根域> */
  baseUrl?: string
  /** 讲解管理服务 SG 网关基址；缺省同上 */
  explainGatewayUrl?: string
  theme?: ExplainTheme
  /** 可选品牌主色（#RRGGBB），不改变深浅模式。 */
  accentColor?: string
  /** 'true'/'false'；缺省取 queryRobotConfig.isInterrupt（默认允许） */
  askEnabled?: string
  avatarUrl?: string
  position?: string
  /** 'true' 时挂载即自动发起讲解 */
  autoOpen?: string
  /** 浮动图标是否可拖动：attribute 传 'true'/'false'（裸 attribute 视为 true），v-bind/property 可传 boolean；未传回落 robotSet.ext.avatarDraggable，缺省不可拖 */
  avatarDraggable?: string | boolean
  /** 是否显示浮动形象入口：attribute 传 'true'/'false'，v-bind/property 可传 boolean；隐藏后入口只剩命令式 API（start/open），缺省显示 */
  showAvatar?: string | boolean
  /** 语音识别后的发送方式：'auto' 识别即发送 / 'fill' 回填输入框手动发送；显式传值 > robotSet.ext.voiceSendMode > 缺省 auto；迷你浮层无输入框强制 auto */
  voiceSendMode?: string
  /* ── property 注入（函数/对象，attribute 传不了） ── */
  tokenProvider?: () => string
  mdContextProvider?: () => string | Promise<string>
  transport?: ExplainTransport
  synthesizer?: TtsSynthesizer
  repository?: RestTeldHubSessionRepository
  explainService?: ExplainServiceClient
  /** 注入预建控制器（headless 对接形态）；注入后其余服务参数不参与 */
  bot?: ExplainController
}>(), {
  // 显式 undefined 缺省：避免 Boolean 联合类型触发 Vue 布尔强转（未传 → false）截断 ext 回落 / 误关入口
  avatarDraggable: undefined,
  showAvatar: undefined,
})

const emit = defineEmits<{
  (e: 'bot-start'): void
  (e: 'bot-theme', theme: ExplainTheme): void
  (e: 'bot-state', snapshot: ExplainStateSnapshot): void
  (e: 'bot-subtitle', line: ScriptLine): void
  (e: 'bot-ask', question: string): void
  (e: 'bot-answer', answer: string): void
  (e: 'bot-error', error: NonNullable<ExplainStateSnapshot['error']>): void
  (e: 'bot-close'): void
  (e: 'bot-dismiss'): void
}>()

/* ────────── 控制器装配 ────────── */
const createdBots: ExplainController[] = []
let internalBot: ExplainController | null = null
/** 组件自建 repository 的 options 引用：queryRobotConfig 返回 hubDomain 后在此回填 baseUrl */
let repoOptions: { baseUrl: string, getToken: () => string } | null = null

/** 无宿主注入时的默认令牌：读平台登录 Cookie（不依赖 TFF 全局） */
function readDefaultToken (): string {
  try {
    const cookie = (typeof document !== 'undefined' && document.cookie) || ''
    const pick = (name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie)?.[1] || ''
    return decodeURIComponent(pick('telda') || pick('teldk') || '')
  } catch { return '' }
}

function ensureBot (): ExplainController {
  if (props.bot) return props.bot
  if (!internalBot) {
    const token = props.tokenProvider || readDefaultToken
    // options 存到组件级引用：queryRobotConfig 返回 hubDomain 后回填即可生效
    // （repository 每次请求实时读 options.baseUrl）；宿主显式传 base-url 时不覆盖
    repoOptions = {
      baseUrl: props.baseUrl || deriveBaseUrlFromLocation(),
      getToken: token,
    }
    const repository = props.repository || new RestTeldHubSessionRepository(repoOptions)
    const service = props.explainService || new ExplainServiceClient({
      gatewayBaseUrl: props.explainGatewayUrl || deriveBaseUrlFromLocation(),
      getToken: token,
      transport: props.transport,
    })
    // 后端批量合成 adapter：filter 契约 {configId, data:[{speaker,text,style}]}
    // （style 随讲解稿透传）；出参 {audios:[{lineId?,audio}]}，无 lineId 按序对应
    const backendSynth = createBatchSynthesizer(async (lines) => {
      const result = await service.synthesizeSpeech({
        configId: props.configId || '',
        data: lines.map(l => ({ speaker: l.speaker, text: l.text, ...(l.style ? { style: l.style } : {}) })),
      }) as { audios?: Array<{ lineId?: string, audio: string }> }
      return result?.audios || []
    })
    const synthesizer = props.synthesizer || createCompositeSynthesizer(backendSynth, createBrowserSynthesizer())
    internalBot = createExplainController({
      explainService: service,
      repository,
      synthesizer,
      configId: props.configId || '',
      // mdSource 可异步：点击发起（start）时才调用 provider 取数，失败由宿主包装层兜底
      mdSource: async () => ({
        ...(props.mdContextProvider ? { mdContext: await props.mdContextProvider() } : {}),
        ...(props.mdSearchParam ? { mdSearchParam: props.mdSearchParam } : {}),
      }),
    })
    createdBots.push(internalBot)
  }
  return internalBot
}

/* ────────── 状态订阅 ────────── */
const snapshot = ref<ExplainStateSnapshot | null>(null)
const panelModeKey = 'aeb:panel-mode:v1'
function readPanelMode() {
  try { return window.localStorage.getItem(panelModeKey) === 'expanded' } catch { return false }
}
const expanded = ref(readPanelMode())
function setPanelMode(value: boolean) {
  expanded.value = value
  try { window.localStorage.setItem(panelModeKey, value ? 'expanded' : 'mini') } catch { /* 存储受限时仍可正常切换。 */ }
}
const panelOpen = ref(false)
/** 浮动图标显示门控：queryRobotConfig 落定（成败都算）后才显示，避免配置到达瞬间的换图/换位跳变 */
const configReady = ref(false)
/** 浮动图标 ✕ 关闭后的整体隐藏门控：隐藏即停播，宿主经 open() 恢复 */
const dismissed = ref(false)
const askInput = ref('')
const voiceStarting = ref(false)
const voiceFinishing = ref(false)
const voiceCancelRequested = ref(false)
const recordingSeconds = ref(0)
const waveformLevels = ref<number[]>(Array(44).fill(0))
let lastWaveformAt = 0
let recordingTimer: ReturnType<typeof setInterval> | null = null
const subtitleVisible = ref(true)
const subtitleBox = ref<HTMLElement | null>(null)
const progressEl = ref<HTMLElement | null>(null)
let seenLines = 0
let lastAnswer = ''
let lastError: ExplainStateSnapshot['error'] = null

function attachBot (bot: ExplainController) {
  bot.subscribe((s) => {
    snapshot.value = s
    // queryRobotConfig 返回 hubDomain 后回填自建 repository 的 baseUrl：
    // 宿主显式传 base-url / 注入 repository 时不覆盖（优先级：宿主 > hubDomain > 域名推导）
    if (repoOptions && s.robotConfig?.hubDomain && !props.baseUrl && !props.repository) {
      repoOptions.baseUrl = s.robotConfig.hubDomain
    }
    if (s.lines.length < seenLines) seenLines = 0
    if (s.lines.length > seenLines) {
      for (const line of s.lines.slice(seenLines)) emit('bot-subtitle', line)
      seenLines = s.lines.length
      void nextTick(scrollToCurrent)
    }
    if (s.answerText !== lastAnswer) {
      if (s.answerStatus === 'none' && lastAnswer && s.phase !== 'answering') emit('bot-answer', s.answerText)
      lastAnswer = s.answerText
    }
    if (s.error !== lastError) {
      lastError = s.error
      if (s.error) emit('bot-error', s.error)
    }
    emit('bot-state', s)
  })
}

const botRef = computed(() => ensureBot())
attachBot(botRef.value)
const snap = computed(() => snapshot.value)
const { state: robotVisualState, revision: robotVisualRevision, idleEnabled: robotIdleEnabled, finishAction: finishRobotAction } = useRobotVisualState(snap)
const {
  rate, isScrubbing, duration, ratio, atEnd, clock, totalClock, timelineReady, answerTimeline,
  seekTo, seekBy, beginScrub, updateScrub, endScrub, cancelScrub, cycleRate, skipSec,
} = useExplainPlayer(snap, botRef)

/* ────────── 派生视图状态 ────────── */
const phase = computed(() => snap.value?.phase || 'idle')
const preparing = computed(() => ['assembling', 'generating', 'interpreting'].includes(phase.value))
const playing = computed(() => phase.value === 'playing' || (phase.value === 'answering' && answerStatus.value === 'playing'))
const answering = computed(() => phase.value === 'answering')
/** 录音及识别期间锁住主轨控制，避免与语音输入抢占播放。 */
const timelineVisible = computed(() => !['idle', 'assembling', 'generating'].includes(phase.value) && answerStatus.value !== 'analyzing')
const controlReady = computed(() => !snap.value?.updating && !snap.value?.updateFailed && !voiceBusy.value && (['interpreting', 'playing', 'paused', 'ended'].includes(phase.value) || (answering.value && ['playing', 'paused'].includes(answerStatus.value) && timelineReady.value)))
/** 主控播放入口放宽：回答暂停中仍可用——组头 ▶ 继续回答 / 主控 ▶ 回主轨双通道 */
const playControlReady = computed(() => !voiceBusy.value && (controlReady.value || (answering.value && ['playing', 'paused'].includes(answerStatus.value))))
/** 追问入口(输入框/发送/语音)放宽：回答暂停中仍可继续追问(收口暂停组发起新追问) */
const askReady = computed(() => !voiceBusy.value && !snap.value?.updating && !snap.value?.updateFailed && ((!answering.value && controlReady.value) || (answering.value && answerStatus.value === 'paused')))
const answerStatus = computed(() => snap.value?.answerStatus || 'none')
const playLoading = computed(() => !playControlReady.value && (preparing.value || !!snap.value?.updating || answerStatus.value === 'analyzing'))
const bubblePlaybackReady = computed(() => !voiceBusy.value && !snap.value?.updating && !snap.value?.updateFailed && (['playing', 'paused', 'ended'].includes(phase.value) || (answering.value && answerStatus.value !== 'analyzing')))
function playBubble (index: number) {
  if (!bubblePlaybackReady.value) return
  followPaused.value = false
  void botRef.value.playLine(index)
}
function playAnswerBubble (id: string, done: boolean) {
  if ((!done && id !== activeGroupId.value) || !bubblePlaybackReady.value) return
  if (answering.value && activeGroupId.value === id) {
    if (answerStatus.value === 'playing') botRef.value.pause()
    else if (answerStatus.value === 'paused') void botRef.value.play()
    return
  }
  botRef.value.replayAnswer(id)
}

const voiceState = computed(() => snap.value?.voiceState || 'idle')
const voiceBusy = computed(() => voiceStarting.value || voiceFinishing.value || voiceState.value !== 'idle')
const recordingClock = computed(() => `${String(Math.floor(recordingSeconds.value / 60)).padStart(2, '0')}:${String(recordingSeconds.value % 60).padStart(2, '0')}`)
const questionText = computed(() => snap.value?.questionText || '')
/** 回答播报进行中的行下标（-1 = 未在播报；活动组口径） */
const answerLineIndex = computed(() => snap.value?.answerLineIndex ?? -1)
const lines = computed(() => snap.value?.lines || [])
const currentLineIndex = computed(() => snap.value?.currentLineIndex ?? -1)
/** 追问对话分组(历史保留)+ 当前活动组 id(高亮/折叠聚焦) */
const dialogGroups = computed(() => snap.value?.dialogGroups || [])
const activeGroupId = computed(() => snap.value?.activeGroupId || null)
const hasPanelContent = computed(() => lines.value.length > 0 || dialogGroups.value.length > 0 || !!snap.value?.contextHistory?.length)
const miniPreview = computed(() => {
  if (voiceBusy.value) return ''
  if (answering.value) return questionText.value
  const group = dialogGroups.value.find(g => g.id === activeGroupId.value)
  if (answerLineIndex.value >= 0) return group?.answerLines?.[answerLineIndex.value]?.text || questionText.value
  return lines.value[currentLineIndex.value]?.text || questionText.value || lines.value[0]?.text || ''
})
/** 进度条打断点标记:每组追问在主轨上的发生位置(有断点才渲染) */
const progressMarkers = computed(() => dialogGroups.value.filter(g => g.breakpoint > 0))
const canInterrupt = computed(() => snap.value?.isInterruptEnabled ?? props.askEnabled !== 'false')
const errorMessage = computed(() => {
  if (snap.value?.error && phase.value === 'error') return snap.value.error.message
  if (voiceState.value !== 'idle' || answering.value) return ''
  // 语音识别失败等非终态错误短提示由事件通道负责；这里只展示终态
  return ''
})
/** 错误提示 toast 化：出现 5s 自动隐藏（error 本身是终态语义，隐藏只关 UI 提示、不动状态）。
 *  具体原因只进控制台，界面一律笼统提示不暴露内部信息 */
const ERROR_TOAST_TEXT = '讲解出现异常，请稍后重试'
const errorToast = ref(false)
let errorToastTimer: ReturnType<typeof setTimeout> | null = null
watch(errorMessage, (msg) => {
  if (errorToastTimer) { clearTimeout(errorToastTimer); errorToastTimer = null }
  if (!msg) { errorToast.value = false; return }
  console.error('[ai-explain] 讲解异常:', snap.value?.error ?? msg)
  errorToast.value = true
  errorToastTimer = setTimeout(() => { errorToast.value = false; errorToastTimer = null }, 5000)
}, { immediate: true }) // 挂载即带 error 的场景(初始快照)也要起 toast
const currentTheme = computed<ExplainTheme>(() => {
  // theme 属性显式传值优先；未传时由 themeColor 判定：hex 按亮度，
  // 非十六进制字面量（如 dark/light）原样作 key，其余兜底 light
  if (props.theme === 'dark' || props.theme === 'light') return props.theme
  const derived = themeFromColor(robotSet.value?.themeColor)
  return derived === 'dark' || derived === 'light' ? derived : 'light'
})
const robotSet = computed(() => snap.value?.robotConfig?.robotSet || null)
const currentScenarioName = computed(() => props.scenarioName || '讲解')
const currentPosition = computed(() => props.position || robotSet.value?.position || 'bottom-right')
const avatarSrc = computed(() => props.avatarUrl || robotSet.value?.robotImage || '')
const avatarStyle = computed(() => {
  const size = robotSet.value?.robotSize
  const style: Record<string, string> = {}
  if (size?.width) style.width = `${size.width}px`
  if (size?.height) style.height = `${size.height}px`
  return style
})

/** 浮动图标可拖动开关：attribute/v-bind 显式传值（string|boolean 归一化）优先，未传回落 robotSet.ext.avatarDraggable（true/'true' 均认），缺省不可拖 */
const avatarDraggableEnabled = computed(() => {
  const v = props.avatarDraggable
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  if (v === '') return true // 裸 attribute 按 HTML 布尔惯例视为 true
  const flag = robotSet.value?.ext?.avatarDraggable
  return flag === true || flag === 'true'
})

/** 浮动形象入口显示开关：attribute/v-bind 显式传值（string|boolean 归一化），仅 false/'false' 隐藏，缺省显示 */
const showAvatarEnabled = computed(() => !(props.showAvatar === false || props.showAvatar === 'false'))

/** 拖动后的浮动图标位置（视口坐标，fixed 定位）；null = 未拖动，随 pos-* 停靠在配置角落。播放器不跟随此值 */
const dragPos = ref<{ left: number, top: number } | null>(null)
const avatarWrapStyle = computed(() => dragPos.value
  ? ({ position: 'fixed', left: `${dragPos.value.left}px`, top: `${dragPos.value.top}px` } as Record<string, string>)
  : {})
/** 预制主题 token 以行内样式注入（宿主可在元素上覆写 --aeb-*） */
const robotStyle = computed(() => {
  // 颜色不再逐项覆盖：主题整体由 theme 属性 / themeFromColor(themeColor) 判定
  const tokens = { ...themeTokens[currentTheme.value] }
  const accent = props.accentColor
  if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
    const rgb = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16)).join(', ')
    tokens['--aeb-accent'] = accent
    tokens['--aeb-accent-fg'] = '#ffffff'
    tokens['--aeb-focus'] = accent
    tokens['--aeb-accent-soft'] = `rgba(${rgb}, 0.12)`
    tokens['--aeb-highlight'] = `rgba(${rgb}, ${currentTheme.value === 'dark' ? 0.24 : 0.08})`
  }
  return tokens as Record<string, string>
})
// 运行时主题外泄（bot-theme）：宿主按最终主题决定是否覆写 --aeb-* token
// （如 AiExplainHost 同步 --aeb-accent）；theme 未传时由 themeColor 异步判定，
// 故 immediate 与后续变化都派发。置于依赖（robotSet）声明之后，immediate 求值才不踩 TDZ
watch(currentTheme, t => emit('bot-theme', t), { immediate: true })

const STATUS_TEXT: Partial<Record<string, string>> = {
  idle: '点击开始讲解',
  assembling: '正在准备…',
  generating: '正在分析内容…',
  interpreting: '解读中…',
  playing: '播报中',
  paused: '已暂停',
  ended: '已结束',
}
const statusText = computed(() => {
  if (snap.value?.updating) return '正在更新讲解…'
  if (snap.value?.updateFailed) return '讲解更新失败'
  if (phase.value === 'answering') {
    if (answerStatus.value === 'analyzing') return '正在思考…'
    if (answerStatus.value === 'paused') return '回答已暂停'
    return '回答播报中'
  }
  if (phase.value === 'error') {
    // 异常信息只走 aeb-error toast,播放器状态行不再显示错误文本
    return ''
  }
  return STATUS_TEXT[phase.value] || ''
})

/** 解读人展示名：voiceSetting.voices 按 role 取 displayName，未配置回落内置 小电/小特 */
const voiceNames = computed(() => new Map(
  (snap.value?.robotConfig?.voiceSetting?.voices || []).map(v => [v.role, v.displayName]),
))

function speakerName (speaker: string) {
  return voiceNames.value.get(speaker) || SPEAKER_META[speaker]?.name || speaker
}

/** 字幕滚动跟随:高亮行推进时滚到当前行;用户手动滚动期间暂停(wheel/触摸/按下触发,滚回底部或 3s 无操作恢复) */
const followPaused = ref(false)
let followResumeTimer: ReturnType<typeof setTimeout> | null = null
const pauseFollow = () => {
  followPaused.value = true
  if (followResumeTimer) clearTimeout(followResumeTimer)
  followResumeTimer = setTimeout(() => { followPaused.value = false; followResumeTimer = null }, 3000)
}
const onSubtitleScroll = () => {
  const box = subtitleBox.value
  if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 40) {
    // 用户滚回底部附近:立即恢复跟随
    followPaused.value = false
    if (followResumeTimer) { clearTimeout(followResumeTimer); followResumeTimer = null }
  }
}

function scrollToCurrent () {
  if (followPaused.value) return // 用户滚动查看历史,不抢滚动条
  const box = subtitleBox.value
  // 切换后保持暂停也要让新内容进入可视区域。
  if (snap.value?.contextHistory?.length && currentLineIndex.value < 0) {
    if (box) box.scrollTop = box.scrollHeight
    return
  }
  // 对话开始后跟随最新消息，恢复主讲解时不再把用户滚回旧字幕。
  if (dialogGroups.value.length && answerLineIndex.value < 0) {
    if (box) box.scrollTop = box.scrollHeight
    return
  }
  // 回答播报期优先定位回答高亮行（主轨行此时不让位高亮，避免滚错目标）
  const active = box?.querySelector('.aeb-answerline.aeb-active') || box?.querySelector('.aeb-active')
  active?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}

/** 提问后定位:滚到最底部(新组头可见)。提问是用户主动行为,无视 followPaused 并恢复后续跟随 */
function scrollToBottom () {
  const box = subtitleBox.value
  if (!box) return
  followPaused.value = false
  if (followResumeTimer) { clearTimeout(followResumeTimer); followResumeTimer = null }
  box.scrollTop = box.scrollHeight
}

/** 主轨行推进/回答行推进/新分组入列时滚到当前行 */
watch(
  [questionText, answerLineIndex, currentLineIndex, () => dialogGroups.value.length],
  () => { void nextTick(scrollToCurrent) },
)

watch(() => dialogGroups.value.length, (n, o) => {
  if (n > o) void nextTick(scrollToBottom)
})
watch(activeGroupId, (now, was) => {
  if (now === null && was) void nextTick(scrollToBottom)
})

/** 进度条打断点标记点击:跳转到该组打断点(带播放极性,走 useExplainPlayer.seekTo) */
const seekToMarker = (g: { breakpoint: number }) => { void seekTo(g.breakpoint) }

/* ────────── 动作 ────────── */
/** 发起讲解（浮动图标点击 / autoOpen / 宿主 start() 同源）：恢复可见 + 打开面板 + 未发起时发起（已有稿件不重播） */
async function startExplain () {
  expanded.value = readPanelMode()
  // 播放器重新可见：若关闭前在播，控制器从断点自动续播
  botRef.value?.setVisible?.(true)
  panelOpen.value = true
  const bot = ensureBot()
  if (!props.configId) return
  emit('bot-start')
  if (!lines.value.length && phase.value !== 'answering') {
    await bot.start()
  }
}

function togglePlay () {
  const bot = botRef.value
  if (!bot) return
  // 底部控制区始终控制当前连续播报任务。
  if (playing.value) bot.pause()
  else void bot.play()
}

function close () {
  panelOpen.value = false
  cancelScrub()
  // 播放器隐藏即停播：停当前句、停后续合成请求（可选链兼容未实现 setVisible 的旧注入 bot）
  botRef.value?.setVisible?.(false)
  void cancelClickVoice()
  emit('bot-close')
}

/* ────────── 浮动图标拖拽（仅移动图标；播放器仍按配置 position 停靠） ────────── */
/** 位移超过该值（px）认定为拖动而非点击 */
const AVATAR_DRAG_THRESHOLD = 5
let dragGesture: { startX: number, startY: number, baseLeft: number, baseTop: number, width: number, height: number, moved: boolean } | null = null
/** 拖动结束置位、由紧随的 click 消费：防止拖动收尾 click 误发起讲解 */
let justDragged = false

function onAvatarPointerDown (e: PointerEvent) {
  justDragged = false
  if (!avatarDraggableEnabled.value || e.button !== 0) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dragGesture = { startX: e.clientX, startY: e.clientY, baseLeft: rect.left, baseTop: rect.top, width: rect.width, height: rect.height, moved: false }
  // move/up 挂 window：拖出图标范围也能跟手与收尾（清理见 onAvatarPointerUp 与 onBeforeUnmount）
  window.addEventListener('pointermove', onAvatarPointerMove)
  window.addEventListener('pointerup', onAvatarPointerUp)
}

function onAvatarPointerMove (e: PointerEvent) {
  const g = dragGesture
  if (!g) return
  const dx = e.clientX - g.startX
  const dy = e.clientY - g.startY
  if (!g.moved && Math.hypot(dx, dy) <= AVATAR_DRAG_THRESHOLD) return
  g.moved = true
  dragPos.value = clampDragPos(g.baseLeft + dx, g.baseTop + dy, g.width, g.height)
}

function onAvatarPointerUp () {
  const g = dragGesture
  dragGesture = null
  window.removeEventListener('pointermove', onAvatarPointerMove)
  window.removeEventListener('pointerup', onAvatarPointerUp)
  if (g?.moved) justDragged = true
}

/** 视口内裁剪：jsdom 等无视口尺寸的环境（clientWidth/Height 为 0）跳过 */
function clampDragPos (left: number, top: number, w: number, h: number) {
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  if (!vw || !vh) return { left, top }
  return {
    left: Math.min(Math.max(0, left), Math.max(0, vw - w)),
    top: Math.min(Math.max(0, top), Math.max(0, vh - h)),
  }
}

async function onAvatarClick () {
  // 拖动结束的收尾 click 不发起讲解
  if (justDragged) { justDragged = false; return }
  await startExplain()
}

/** 关闭整个组件（浮动图标 ✕）：复用「隐藏即停播」链路，宿主经 open() 恢复 */
function dismiss () {
  dismissed.value = true
  panelOpen.value = false
  cancelScrub()
  botRef.value?.setVisible?.(false)
  void cancelClickVoice()
  emit('bot-dismiss')
}

async function submitAsk () {
  const text = askInput.value.trim()
  if (!text || !askReady.value) return
  askInput.value = ''
  emit('bot-ask', text)
  await ensureBot().askText(text)
}

/* ────────── 点击录音：开始 / 结束并发送 / 独立取消 ────────── */
// 新版默认结束即发送；宿主显式配置 fill 时仍支持识别回填、手动发送。
const voiceSendMode = computed(() => {
  const pick = (v: unknown) => (v === 'auto' || v === 'fill' ? v : null)
  return pick(props.voiceSendMode) ?? pick(robotSet.value?.ext?.voiceSendMode) ?? 'auto'
})

watch(voiceState, (state) => {
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null }
  if (state === 'recording') {
    recordingSeconds.value = 0
    waveformLevels.value = Array(44).fill(0)
    const started = Date.now()
    recordingTimer = setInterval(() => { recordingSeconds.value = Math.floor((Date.now() - started) / 1000) }, 250)
  }
})

async function startClickVoice () {
  if (!askReady.value || !canInterrupt.value || voiceBusy.value) return
  const bot = ensureBot()
  voiceStarting.value = true
  voiceCancelRequested.value = false
  try {
    await bot.startVoiceInput({ onLevel: (level) => {
      if (voiceCancelRequested.value) return
      const now = Date.now()
      if (now - lastWaveformAt < 65) return
      lastWaveformAt = now
      const rms = Number.isFinite(level) ? Math.min(1, Math.max(0, level) * 5) : 0
      waveformLevels.value = [...waveformLevels.value.slice(1), rms]
    } })
    // 权限申请未完成时取消 / 关闭，拿到麦克风后立即释放，不识别、不发送。
    if (voiceCancelRequested.value) await bot.stopVoiceInput({ cancel: true })
  } finally {
    voiceStarting.value = false
  }
}

async function finishClickVoice () {
  if (voiceStarting.value || voiceFinishing.value || voiceState.value !== 'recording') return
  voiceFinishing.value = true
  try {
    if (expanded.value && voiceSendMode.value === 'fill') {
      const result = await ensureBot().stopVoiceInput({ ask: false })
      if (result && typeof result.text === 'string') askInput.value = result.text
    } else {
      await ensureBot().stopVoiceInput()
    }
  } finally {
    voiceFinishing.value = false
  }
}

async function cancelClickVoice () {
  voiceCancelRequested.value = true
  if (voiceStarting.value || voiceFinishing.value || voiceState.value !== 'recording') return
  await ensureBot().stopVoiceInput({ cancel: true })
}

function onVoiceKeydown (event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!voiceStarting.value && voiceState.value !== 'recording')) return
  event.preventDefault()
  void cancelClickVoice()
}

/* 进度条拖拽（拖动中真实播放照常推进，松手落真 seek） */
function progressSecFromEvent (e: PointerEvent) {
  const rect = progressEl.value!.getBoundingClientRect()
  return (e.clientX - rect.left) / Math.max(1, rect.width) * duration.value
}
function onProgressDown (e: PointerEvent) {
  if (!controlReady.value || !duration.value) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  beginScrub(progressSecFromEvent(e))
}
function onProgressMove (e: PointerEvent) {
  if (isScrubbing.value) updateScrub(progressSecFromEvent(e))
}
function onProgressUp (e: PointerEvent) {
  if (!isScrubbing.value) return
  try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
  void endScrub(progressSecFromEvent(e))
}

onMounted(async () => {
  window.addEventListener('keydown', onVoiceKeydown)
  // 配置就绪（成功或失败）前不显示浮动图标，避免默认形象→配置形象的瞬间跳变
  await ensureBot().loadRobotConfig()
  configReady.value = true
  if (props.autoOpen === 'true') void startExplain()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onVoiceKeydown)
  if (recordingTimer) clearInterval(recordingTimer)
  botRef.value?.setVisible?.(false)
  void cancelClickVoice()
  // 拖拽 window 监听兜底清理（正常由 pointerup 收尾）
  window.removeEventListener('pointermove', onAvatarPointerMove)
  window.removeEventListener('pointerup', onAvatarPointerUp)
  if (errorToastTimer) { clearTimeout(errorToastTimer); errorToastTimer = null }
  // 只销毁组件内部创建的控制器；注入的 bot 生命周期归宿主
  for (const bot of createdBots) bot.destroy()
  createdBots.length = 0
  internalBot = null
})

/* ────────── 宿主命令式 API（defineExpose → 元素实例，vue ≥3.3） ────────── */
defineExpose({
  bot: botRef,
  open: () => { expanded.value = readPanelMode(); dismissed.value = false; botRef.value?.setVisible?.(true); panelOpen.value = true },
  /** 打开面板并发起讲解（与浮动图标点击同源）；已有稿件只恢复面板 */
  start: startExplain,
  refresh: (update: DataSourceUpdate) => {
    voiceCancelRequested.value = true
    askInput.value = ''
    seenLines = 0
    return ensureBot().refresh(update)
  },
  retryRefresh: () => ensureBot().retryRefresh(),
  close,
  dismiss,
  play: () => void botRef.value?.play(),
  pause: () => botRef.value?.pause(),
  ask: (text: string) => ensureBot().askText(text),
  stop: () => ensureBot().handleControlIntent('stop'),
  /** 回答暂停中收口回主轨（未播完断点续播 / 已播完重头播） */
  resumeMainTrack: () => botRef.value?.resumeMainTrack?.(),
})
</script>

<style scoped>
.aeb-root {
  position: fixed; z-index: var(--aeb-z); color: var(--aeb-fg);
  font: 400 var(--aeb-font-size)/1.5 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.aeb-root *, .aeb-root *::before, .aeb-root *::after { box-sizing: border-box; }
.aeb-root button, .aeb-root input { font: inherit; }
.aeb-root button { -webkit-tap-highlight-color: transparent; }
.aeb-root svg { display: block; flex-shrink: 0; stroke-width: 2; pointer-events: none; }
.aeb-root.pos-bottom-right { right: 28px; bottom: 28px; }
.aeb-root.pos-bottom-left { left: 28px; bottom: 28px; }
.aeb-root.pos-top-right { right: 28px; top: 28px; }
.aeb-root.pos-top-left { left: 28px; top: 28px; }
.aeb-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }

/* CSS orb: no remote asset; configured host avatars still take precedence. */
.aeb-orb { display: block; position: relative; flex-shrink: 0; border-radius: 50%; isolation: isolate; overflow: hidden; background: #a3cbd3;
  box-shadow: inset 0 0 14px #ffffff70, 0 8px 20px #457d8b12; }
.aeb-orb-surface { position: absolute; inset: -24%; border-radius: 50%;
  background: radial-gradient(ellipse at 26% 32%, #ede6a2 0%, #d3dcb1 15%, transparent 43%), radial-gradient(ellipse at 78% 23%, #c7eafa 0%, #8ec9e8 24%, transparent 49%), radial-gradient(ellipse at 72% 76%, #3393b8 0%, #69c1d7 25%, transparent 48%), radial-gradient(ellipse at 28% 75%, #4e7683 0%, #85aaa8 29%, transparent 52%), conic-gradient(from 30deg, #91c9e4, #a4e0dd, #479cb3, #a0ad8f, #d7e2c5, #91c9e4);
  filter: blur(6px); transform: rotate(-18deg); animation: aeb-orbit 20s linear infinite; }
.aeb-orb::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 2px 7px #ffffff6e, inset 0 -6px 14px #28657a1a; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' opacity='.15' filter='url(%23n)'/%3E%3C/svg%3E"); mix-blend-mode: soft-light; pointer-events: none; }
.is-speaking .aeb-orb-surface { animation-duration: 7s; }
.is-listening .aeb-orb { animation: aeb-listen 1.5s ease-in-out infinite; }
.is-thinking .aeb-orb-surface { animation-duration: 3s; }
@keyframes aeb-orbit { to { transform: rotate(342deg); } }
@keyframes aeb-listen { 50% { box-shadow: 0 0 0 9px #9bced92a, 0 0 0 18px #9bced912; } }

/* Floating entry */
.aeb-avatar-wrap { position: relative; display: inline-block; }
.aeb-avatar { display: grid; place-items: center; width: var(--aeb-avatar-size); height: var(--aeb-avatar-size); padding: 7px; border: 1px solid var(--aeb-border); border-radius: 50%; background: var(--aeb-bg); box-shadow: var(--aeb-shadow); cursor: pointer; transition: transform .2s; }
.aeb-avatar:hover { transform: translateY(-3px); }
.aeb-avatar img, .aeb-avatar-fallback { width: 100%; height: 100%; object-fit: contain; }
.aeb-avatar.aeb-draggable { touch-action: none; user-select: none; cursor: grab; }
.aeb-avatar.aeb-draggable:active { cursor: grabbing; }
.aeb-avatar-close { position: absolute; top: -3px; right: -3px; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 1px solid var(--aeb-border); border-radius: 50%; background: var(--aeb-bg); color: var(--aeb-fg-secondary); cursor: pointer; transition: opacity .15s; }
@media (hover: hover) { .aeb-avatar-close { opacity: 0; } .aeb-avatar-wrap:hover .aeb-avatar-close, .aeb-avatar-wrap:focus-within .aeb-avatar-close { opacity: 1; } }

/* Shared surface and controls */
.aeb-mini, .aeb-panel { background: var(--aeb-bg); border: 1px solid var(--aeb-border); border-radius: var(--aeb-radius); box-shadow: var(--aeb-shadow); overflow: hidden; animation: aeb-enter .24s ease-out; }
@keyframes aeb-enter { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
.aeb-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.aeb-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; }
.aeb-title-divider { color: var(--aeb-fg-secondary); font-weight: 400; }
.aeb-scenario { overflow: hidden; text-overflow: ellipsis; font-weight: 400; color: var(--aeb-fg-secondary); }
.aeb-icon, .aeb-btn { display: inline-flex; justify-content: center; align-items: center; flex-shrink: 0; border: none; background: transparent; color: var(--aeb-fg-secondary); cursor: pointer; border-radius: 50%; padding: 0; height: 34px; min-width: 34px; transition: background .15s, color .15s, transform .15s; }
.aeb-icon { height: 30px; min-width: 30px; color: var(--aeb-fg); }
.aeb-icon:hover:not(:disabled), .aeb-btn:hover:not(:disabled) { background: var(--aeb-bg-soft); color: var(--aeb-fg); }
.aeb-root button:focus-visible { outline: 2px solid var(--aeb-focus); outline-offset: 3px; }
.aeb-clock, .aeb-clockrow, .aeb-stamp { font-variant-numeric: tabular-nums; }
.aeb-status-dot { width: 5px; height: 5px; display: inline-block; flex-shrink: 0; border-radius: 50%; background: #8bad9d; }
.is-speaking .aeb-status-dot, .is-listening .aeb-status-dot { background: #649d88; box-shadow: 0 0 0 3px #8fb6a41c; }

/* Mini: same actions, generous breathing room and readable current sentence */
.aeb-mini { width: 344px; padding: 13px 15px 14px; }
.aeb-mini-body { display: flex; align-items: center; gap: 15px; padding: 20px 3px 18px; }
.aeb-orb-mini { width: 58px; height: 58px; }
.aeb-mini-copy { flex: 1; min-width: 0; }
.aeb-status { display: flex; align-items: center; gap: 7px; margin: 0 0 6px; color: var(--aeb-fg); font-size: 14px; font-weight: 500; }
.aeb-mini-summary { margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 14px; line-height: 1.65; color: var(--aeb-fg-secondary); }
.aeb-mini-actions { gap: 6px; padding-top: 10px; border-top: 1px solid var(--aeb-border); }
.aeb-mini-actions > .aeb-btn:first-child { background: var(--aeb-accent); color: var(--aeb-accent-fg); }
.aeb-mini-actions > .aeb-btn[aria-label="倍速"] { font-size: 14px; }
.aeb-clock { flex: 1; text-align: center; font-size: 13px; color: var(--aeb-fg-secondary); }

/* Expanded player */
.aeb-panel { width: var(--aeb-panel-width); max-height: min(var(--aeb-panel-height), calc(100dvh - 56px)); display: flex; flex-direction: column; }
.aeb-panel-header { padding: 15px 17px 0; flex-shrink: 0; }
.aeb-status-inline { display: none; }
.aeb-presence { flex-shrink: 0; display: flex; flex-direction: column; align-items: center; padding: 20px 20px 18px; }
.aeb-orb-panel { width: 92px; height: 92px; margin-bottom: 17px; }
.aeb-presence-caption { display: flex; align-items: center; gap: 7px; font-size: 14px; color: var(--aeb-fg); }
.aeb-presence-hint { font-size: 13px; color: var(--aeb-fg-secondary); margin-top: 5px; }
.aeb-subtitles { flex: 1 1 auto; min-height: 100px; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; padding: 4px 20px 16px; scrollbar-width: thin; scrollbar-color: var(--aeb-border) transparent; }
.aeb-placeholder { color: var(--aeb-fg-secondary); text-align: center; margin: 28px 0; }
.aeb-line { display: grid; grid-template-columns: auto auto 1fr; gap: 5px 8px; align-items: baseline; margin: 0 0 10px; padding: 9px 11px; border-radius: 13px; font-size: 14px; line-height: 1.8; color: var(--aeb-fg-secondary); }
.aeb-line.aeb-active { color: var(--aeb-fg); background: var(--aeb-highlight); }
.aeb-speaker { font-size: 12px; color: var(--aeb-fg-secondary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aeb-stamp { font-size: 12px; color: var(--aeb-fg-secondary); }
.aeb-text { grid-column: 1 / -1; min-width: 0; overflow-wrap: anywhere; }
.aeb-line.aeb-active .aeb-text { color: var(--aeb-fg); }
.aeb-dialog-group { margin-top: 14px; border-top: 1px solid var(--aeb-border); padding-top: 12px; }
.aeb-group-head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; margin-bottom: 8px; border-radius: 12px; background: var(--aeb-bg-soft); cursor: pointer; }
.aeb-group-src { color: var(--aeb-fg-secondary); flex-shrink: 0; }
.aeb-group-q { flex: 1; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-align: left; font-size: 14px; line-height: 1.6; }
.aeb-group-caret { color: var(--aeb-fg-secondary); }
.aeb-group-replay { display: grid; place-items: center; flex-shrink: 0; width: 26px; height: 26px; border: none; border-radius: 50%; background: var(--aeb-accent); color: var(--aeb-accent-fg); font-size: 12px; cursor: pointer; }
.aeb-answerline { grid-template-columns: auto 1fr; }
.aeb-answer-pending { padding: 10px; color: var(--aeb-fg-secondary); font-size: 14px; }
.aeb-progress { position: relative; flex-shrink: 0; height: 4px; margin: 7px 24px 8px; border-radius: 10px; background: var(--aeb-border); cursor: pointer; touch-action: none; }
.aeb-progress::before { content: ''; position: absolute; inset: -8px 0; }
.aeb-ratio { height: 100%; border-radius: inherit; background: var(--aeb-accent); transition: width .12s linear; pointer-events: none; }
.aeb-progress-marker { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 15px; height: 15px; border: 2px solid var(--aeb-bg); border-radius: 50%; background: var(--aeb-accent); color: var(--aeb-accent-fg); font-size: 10px; line-height: 11px; text-align: center; z-index: 1; }
.aeb-clockrow { display: flex; justify-content: space-between; margin: 0 24px 2px; font-size: 12px; color: var(--aeb-fg-secondary); flex-shrink: 0; }
.aeb-controls { display: flex; align-items: center; justify-content: center; gap: 17px; padding: 7px 20px 17px; flex-shrink: 0; }
.aeb-controls > .aeb-btn { min-width: 35px; font-size: 13px; }
.aeb-btn.aeb-play { width: 43px; height: 43px; background: var(--aeb-accent); color: var(--aeb-accent-fg); }
.aeb-btn.aeb-play:hover:not(:disabled) { background: var(--aeb-accent); color: var(--aeb-accent-fg); transform: scale(1.04); }
.aeb-mini-actions > .aeb-btn:first-child:hover:not(:disabled) { background: var(--aeb-accent); color: var(--aeb-accent-fg); }
.aeb-line.aeb-past:not(.aeb-active) { opacity: .68; }
.aeb-btn.aeb-off { opacity: .4; }
.aeb-btn:disabled, .aeb-icon:disabled, .aeb-mic:disabled { opacity: .35; cursor: not-allowed; }

/* Single pill composer */
.aeb-ask { display: flex; align-items: center; flex-shrink: 0; gap: 5px; margin: 0 16px 16px; padding: 6px; border: 1px solid var(--aeb-border); border-radius: 28px; background: var(--aeb-bg); transition: border-color .15s, box-shadow .15s; }
.aeb-ask:focus-within { border-color: var(--aeb-focus); }
.aeb-input { flex: 1; width: 0; min-width: 0; padding: 7px 8px 7px 10px; border: 0; background: transparent; color: var(--aeb-fg); outline: none; font-size: 14px !important; }
.aeb-input::placeholder { color: var(--aeb-fg-secondary); }
.aeb-input:disabled { opacity: .5; cursor: not-allowed; }
.aeb-mic { display: grid; place-items: center; position: relative; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: var(--aeb-bg-soft); color: var(--aeb-fg-secondary); cursor: pointer; touch-action: none; user-select: none; }
.aeb-mic.aeb-mic-mini { width: 34px; height: 34px; }
.aeb-mic.aeb-recording { background: var(--aeb-accent); color: var(--aeb-accent-fg); animation: aeb-listen 1.5s ease-in-out infinite; }
.aeb-mic.aeb-cancel-armed { opacity: .55; }
.aeb-voice-tip { position: absolute; bottom: calc(100% + 12px); right: -20px; padding: 7px 12px; border-radius: 12px; background: var(--aeb-bg); color: var(--aeb-fg); border: 1px solid var(--aeb-border); box-shadow: var(--aeb-shadow); font-size: 13px; white-space: nowrap; pointer-events: none; z-index: 3; }
.aeb-voice-tip.aeb-armed { color: #bd5252; }
.aeb-send { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: var(--aeb-accent); color: var(--aeb-accent-fg); cursor: pointer; }
.aeb-send:disabled { background: var(--aeb-bg-soft); color: var(--aeb-fg-secondary); opacity: .5; cursor: not-allowed; }
.aeb-error { position: absolute; bottom: 100%; left: 0; margin: 0 0 10px; padding: 10px 14px; border-radius: 14px; border: 1px solid var(--aeb-border); background: var(--aeb-bg); color: #bd5252; box-shadow: var(--aeb-shadow); width: max-content; max-width: var(--aeb-panel-width); pointer-events: none; font-size: 14px; }
.aeb-root.pos-bottom-right .aeb-error, .aeb-root.pos-top-right .aeb-error { left: auto; right: 0; }
.aeb-root.pos-top-left .aeb-error, .aeb-root.pos-top-right .aeb-error { bottom: auto; top: 100%; margin: 10px 0 0; }
@media (max-width: 768px) {
  .aeb-mini, .aeb-panel { position: fixed; left: 12px; right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); width: auto; max-width: 440px; margin-inline: auto; border-radius: 26px; }
  .aeb-panel { max-height: calc(100dvh - 36px - env(safe-area-inset-bottom)); }
  .aeb-presence { padding-top: 12px; padding-bottom: 14px; }
  .aeb-orb-panel { width: 76px; height: 76px; margin-bottom: 12px; }
  .aeb-controls { gap: 14px; }
  .aeb-error { position: fixed; left: 12px !important; right: 12px !important; top: 12px !important; bottom: auto !important; width: auto; max-width: none; margin: 0; }
}
@media (max-height: 600px) { .aeb-presence { padding: 8px; } .aeb-orb-panel { width: 48px; height: 48px; margin-bottom: 8px; } .aeb-presence-hint { display: none; } .aeb-subtitles { min-height: 60px; } }
@media (prefers-reduced-motion: reduce) { .aeb-root *, .aeb-root *::before, .aeb-root *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
/* Desktop voice interaction: distinct stop and cancel, no gesture cancellation. */
.aeb-click-mic, .aeb-mic.aeb-mic-mini { display: inline-flex; align-items: center; justify-content: center; gap: 5px; width: auto; padding: 0 9px; border-radius: 18px; font-size: 13px; }
.aeb-recording-bar { flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; padding: 13px 15px; margin: 0 16px 16px; border: 1px solid var(--aeb-border); border-radius: 19px; background: var(--aeb-bg-soft); }
.aeb-mini .aeb-recording-bar { margin: 0; }
.aeb-recording-info { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--aeb-fg); min-height: 20px; }
.aeb-recording-dot { width: 7px; height: 7px; border-radius: 50%; background: #be5f56; box-shadow: 0 0 0 4px #be5f5610; animation: aeb-record-blink 1.5s ease-in-out infinite; }
@keyframes aeb-record-blink { 50% { opacity: .4; } }
.aeb-recording-time { margin-left: auto; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--aeb-fg-secondary); }
.aeb-recording-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.aeb-record-cancel { border: 0; padding: 6px 9px; background: transparent; color: var(--aeb-fg-secondary); font-size: 14px !important; cursor: pointer; border-radius: 18px; }
.aeb-record-cancel:hover { color: var(--aeb-fg); background: var(--aeb-border); }
.aeb-record-cancel:disabled { opacity: .4; cursor: default; }
.aeb-record-finish { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 13px; border: 0; border-radius: 20px; background: var(--aeb-accent); color: var(--aeb-accent-fg); font-size: 13px !important; cursor: pointer; }
.aeb-loading { animation: aeb-orbit 1.4s linear infinite; flex-shrink: 0; }
/* Conversation roles: user on the right; AI content and metadata on the left. */
.aeb-subtitles { max-height: 300px; padding-inline: 18px; }
.aeb-subtitles > .aeb-line { max-width: 92%; background: var(--aeb-bg-soft); border-radius: 6px 14px 14px 14px; margin-bottom: 12px; color: var(--aeb-fg-secondary); }
.aeb-subtitles > .aeb-line.aeb-active { background: var(--aeb-highlight); color: var(--aeb-fg); }
.aeb-speaker { width: auto !important; max-width: none; }
.aeb-dialog-group { padding: 0; margin-top: 18px; border-top: 0; }
.aeb-group-head.aeb-user-message { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding: 0; margin: 0 0 15px 15%; border: 0; background: transparent; cursor: pointer; }
.aeb-group-head.aeb-user-message:hover { background: transparent; }
.aeb-user-meta { display: flex; align-items: center; gap: 5px; color: var(--aeb-fg-secondary); font-size: 12px; padding-right: 3px; }
.aeb-group-q { display: block; flex: none; width: fit-content; max-width: 100%; padding: 10px 13px; border-radius: 14px 6px 14px 14px; background: var(--aeb-accent); color: var(--aeb-accent-fg); font-size: 14px; line-height: 1.75; overflow-wrap: anywhere; -webkit-line-clamp: unset; }
.aeb-ai-message { max-width: 94%; margin: 0 0 18px; }
.aeb-ai-meta { display: flex; align-items: center; gap: 6px; color: var(--aeb-fg-secondary); font-size: 12px; margin: 0 0 7px; }
.aeb-chat-orb { width: 19px; height: 19px; box-shadow: none; }
.aeb-ai-meta > span:nth-child(2) { flex: 1; }
.aeb-group-replay { width: 23px; height: 23px; background: var(--aeb-bg-soft); color: var(--aeb-fg); font-size: 11px; }
.aeb-group-toggle { display: grid; place-items: center; width: 23px; height: 23px; border: 0; border-radius: 50%; color: var(--aeb-fg-secondary); background: transparent; cursor: pointer; }
.aeb-group-toggle:hover { background: var(--aeb-bg-soft); }
.aeb-ai-bubble { background: var(--aeb-bg-soft); border-radius: 6px 14px 14px 14px; padding: 4px; }
.aeb-ai-bubble .aeb-answerline { margin: 0; padding: 8px 10px; color: var(--aeb-fg); }
.aeb-ai-bubble .aeb-answerline .aeb-speaker { display: none; }
.aeb-ai-bubble .aeb-answerline.aeb-active { background: var(--aeb-highlight); border-radius: 12px; }
.aeb-answer-pending { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; }
.aeb-answer-collapsed { background: transparent; padding: 8px 0; border: 0; font-size: 13px !important; color: var(--aeb-fg-secondary); cursor: pointer; }
.aeb-root.has-conversation .aeb-presence { flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 8px; padding: 14px 20px; }
.aeb-root.has-conversation .aeb-orb-panel { width: 28px; height: 28px; margin: 0; }
.aeb-root.has-conversation .aeb-presence-hint { display: none; }
@media (prefers-reduced-motion: reduce) { .aeb-recording-dot, .aeb-loading { animation: none; } }

/* Compact conversation: identity lives in the header, content gets the height. */
.aeb-panel-header, .aeb-mini > .aeb-row { gap: 9px; }
.aeb-panel-header { padding: 14px 16px 12px; }
.aeb-header-avatar { display: block; flex-shrink: 0; width: 29px; height: 29px; }
.aeb-header-avatar > .aeb-orb, .aeb-header-avatar > img { width: 100%; height: 100%; border-radius: 50%; object-fit: contain; }
.aeb-heading { flex: 1; min-width: 0; }
.aeb-heading .aeb-title { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
.aeb-heading-status { display: block; margin-top: 2px; color: var(--aeb-fg-secondary); font-size: 12px; line-height: 1.4; }
.aeb-mini { padding: 13px 15px 12px; }
.aeb-mini-body { padding: 12px 2px; }
.aeb-mini-summary { -webkit-line-clamp: 2; }
.aeb-mini-actions { padding-top: 7px; }
.aeb-subtitles { min-height: 120px; max-height: 330px; padding: 3px 16px 12px; }
.aeb-subtitles > .aeb-line { display: block; width: fit-content; max-width: 92%; padding: 10px 13px; margin: 0 0 6px; border-radius: 6px 14px 14px 14px; font-size: 14px; color: var(--aeb-fg); }
.aeb-subtitles .aeb-stamp { display: block; font-size: 11px; margin-bottom: 3px; opacity: .7; }
.aeb-subtitles > .aeb-line .aeb-text { display: block; }
.aeb-subtitles > .aeb-line.aeb-past:not(.aeb-active) { opacity: .86; }
.aeb-dialog-group { margin-top: 13px; }
.aeb-group-head.aeb-user-message { margin-bottom: 9px; gap: 0; }
.aeb-group-q { border-radius: 14px 6px 14px 14px; padding: 9px 13px; }
.aeb-ai-message { margin-bottom: 10px; }
.aeb-ai-bubble { border-radius: 6px 14px 14px 14px; padding: 2px; }
.aeb-ai-meta { justify-content: flex-end; gap: 3px; min-height: 22px; margin: 3px 0 0; }
.aeb-ai-bubble .aeb-line { display: block; }
.aeb-group-replay, .aeb-group-toggle { width: 22px; height: 22px; }
.aeb-progress { margin-top: 4px; }
.aeb-controls { gap: 16px; padding-top: 5px; padding-bottom: 11px; }
.aeb-controls > .aeb-sub { font-size: 13px; border-radius: 14px; min-width: 36px; }
.aeb-ask, .aeb-recording-bar.aeb-voice-capsule { height: 46px; min-height: 46px; max-height: 46px; margin: 0 14px 14px; border-radius: 26px; box-sizing: border-box; }
.aeb-ask { padding: 6px; gap: 5px; }
.aeb-input { font-size: 14px !important; }
.aeb-click-mic, .aeb-mic.aeb-mic-mini { width: 32px; min-width: 32px; height: 32px; padding: 0; border-radius: 50%; }
.aeb-mic:hover:not(:disabled) { background: var(--aeb-border); color: var(--aeb-fg); }
/* Same input capsule footprint: X | actual microphone waveform | check. */
.aeb-recording-bar.aeb-voice-capsule { display: flex; flex-direction: row; align-items: center; gap: 12px; padding: 6px; background: var(--aeb-bg); border: 1.5px solid var(--aeb-accent); }
.aeb-mini .aeb-voice-capsule { margin: 4px 0 0; }
.aeb-voice-capsule .aeb-record-cancel, .aeb-voice-capsule .aeb-record-finish { display: grid; place-items: center; width: 32px; height: 32px; min-width: 32px; padding: 0; flex-shrink: 0; border-radius: 50%; }
.aeb-voice-capsule .aeb-record-cancel { color: var(--aeb-fg-secondary); background: var(--aeb-bg); border: 1px solid var(--aeb-border); box-shadow: 0 1px 3px #0000000b; }
.aeb-voice-capsule .aeb-record-finish { color: var(--aeb-accent-fg); background: var(--aeb-accent); }
.aeb-waveform { flex: 1; display: flex; align-items: center; justify-content: space-between; height: 27px; min-width: 0; overflow: hidden; gap: 3px; }
.aeb-waveform > span { display: block; flex: 1 1 3px; min-width: 1px; max-width: 3px; width: 3px; max-height: 25px; border-radius: 3px; background: var(--aeb-fg-secondary); transition: height 70ms linear; }
.aeb-voice-capsule .aeb-recording-info { flex: 1; min-width: 0; font-size: 13px; gap: 7px; }
.aeb-voice-capsule .aeb-recording-info > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
@media(max-width:768px) { .aeb-panel-header { padding: 13px 14px 11px; } .aeb-subtitles { max-height: 330px; } }
@media(max-height:600px) { .aeb-subtitles { max-height: 220px; min-height: 60px; } .aeb-controls { padding-bottom: 6px; } }
@media(prefers-reduced-motion:reduce) { .aeb-waveform > span { transition: none; } }


/* Mini is a single compact capsule; detailed content belongs to the full panel. */
.aeb-mini { display: flex; align-items: center; gap: 8px; width: 248px; height: 56px; min-height: 56px; padding: 8px 10px; box-sizing: border-box; border-radius: 999px; }
.aeb-mini > .aeb-header-avatar { width: 32px; height: 32px; }
.aeb-capsule-controls { display: flex; align-items: center; justify-content: center; gap: 10px; flex: 1; min-width: 0; }
.aeb-mini .aeb-capsule-play { width: 34px; height: 34px; background: var(--aeb-accent); color: var(--aeb-accent-fg); }
.aeb-mini .aeb-capsule-play:hover:not(:disabled) { background: var(--aeb-accent); color: var(--aeb-accent-fg); opacity: .85; }
.aeb-mini > .aeb-icon { width: 26px; height: 30px; flex-shrink: 0; }
.aeb-mini .aeb-voice-capsule { flex: 1; min-width: 0; width: 0; height: 38px; min-height: 38px; max-height: 38px; margin: 0; padding: 0; gap: 4px; border: 0; box-shadow: none; }
.aeb-mini .aeb-waveform { gap: 2px; }
.aeb-mini .aeb-record-cancel, .aeb-mini .aeb-record-finish { width: 26px; height: 26px; min-width: 26px; }
.aeb-mini .aeb-recording-info { font-size: 12px; gap: 3px; overflow: hidden; }
.aeb-mini .aeb-recording-info span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 768px) { .aeb-mini { left: auto; right: 12px; width: 248px; max-width: calc(100vw - 24px); margin: 0; border-radius: 999px; } }


.aeb-context-divider { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: var(--aeb-fg-secondary); font-size: 12px; }
.aeb-context-divider::before, .aeb-context-divider::after { content: ''; flex: 1; height: 1px; background: var(--aeb-border); }
.aeb-history-line { width: fit-content; max-width: 92%; padding: 10px 13px; margin: 0 0 9px; border-radius: 6px 14px 14px 14px; background: var(--aeb-bg-soft); color: var(--aeb-fg); font-size: 14px; line-height: 1.8; }
.aeb-retry { margin-left: 8px; padding: 0; border: 0; background: none; color: var(--aeb-fg); font: inherit; text-decoration: underline; cursor: pointer; }
.aeb-mini-feedback { flex: 1; display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; color: var(--aeb-fg-secondary); background: transparent; border: 0; padding: 0; }
.aeb-mini > .aeb-mini-feedback { order: 1; }
.aeb-mini > .aeb-header-avatar { order: 0; }
.aeb-mini > .aeb-icon { order: 2; }

.aeb-playable-line[aria-disabled="false"], .aeb-playable-answer[aria-disabled="false"] { cursor: pointer; }
.aeb-playable-line:focus-visible, .aeb-playable-answer:focus-visible { outline: 2px solid var(--aeb-focus); outline-offset: 2px; }

.aeb-root.is-neutral .aeb-orb { filter: grayscale(1); }
.aeb-root.is-neutral .aeb-status-dot { background: var(--aeb-fg-secondary); box-shadow: none; }

/* Transparent IP replaces the default orb; explicit host avatar URLs retain their behavior. */
.aeb-avatar.aeb-avatar-ip { padding: 0; background: transparent; border: 0; border-radius: 0; box-shadow: none; }
.aeb-header-avatar.aeb-header-avatar-ip { width: 40px; height: 40px; overflow: visible; }
.aeb-mini > .aeb-header-avatar.aeb-header-avatar-ip { width: 44px; height: 44px; }
/* Two-line mini player: identity, context, then persistent actions. */
.aeb-mini{width:540px;max-width:calc(100vw - 48px);height:80px;min-height:80px;padding:12px 16px;gap:12px;border:0;border-radius:999px}
.aeb-mini > .aeb-header-avatar.aeb-header-avatar-ip{width:54px;height:54px;flex-shrink:0}
.aeb-mini-copy{flex:1;min-width:0;overflow:hidden}
.aeb-mini-title{font-size:14px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--aeb-fg)}
.aeb-mini-detail{display:flex;align-items:center;gap:10px;min-width:0;margin-top:4px;font-size:12px;line-height:18px;color:var(--aeb-fg-secondary)}
.aeb-mini-state{display:inline-flex;align-items:center;gap:5px;flex-shrink:0}
.aeb-mini-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:1px solid var(--aeb-border);padding-left:10px}
.aeb-mini .aeb-capsule-controls{flex:0 0 auto;gap:8px}
.aeb-mini .aeb-mini-rate{width:42px;padding:0;font-size:12px;background:var(--aeb-bg-soft);border-radius:12px}
.aeb-mini > .aeb-icon{order:0;width:28px}
.aeb-mini .aeb-voice-capsule{flex:0 1 180px;width:auto}
@media(max-width:560px){.aeb-mini{width:calc(100vw - 24px);max-width:none;left:12px;right:12px;gap:8px;padding:10px 12px;height:auto;min-height:78px;border-radius:999px;flex-wrap:wrap}.aeb-mini > .aeb-header-avatar.aeb-header-avatar-ip{width:46px;height:46px}.aeb-mini-copy{flex-basis:calc(100% - 62px)}.aeb-mini .aeb-capsule-controls{margin-left:auto}.aeb-mini .aeb-voice-capsule{flex:1 1 150px}.aeb-mini > .aeb-icon{height:32px}}
/* Keep all mini-player action targets the same size in every layout. */
.aeb-mini .aeb-capsule-controls{gap:8px}
.aeb-mini .aeb-capsule-controls > .aeb-btn,
.aeb-mini > .aeb-icon,
.aeb-mini .aeb-record-cancel,
.aeb-mini .aeb-record-finish{width:34px;min-width:34px;height:34px;min-height:34px;flex-shrink:0;padding:0;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center}
.aeb-mini{gap:8px}
.aeb-avatar.aeb-avatar-ip{position:relative}
.aeb-avatar .aeb-avatar-label{position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:45px;height:19px;object-fit:contain;z-index:4;pointer-events:none;user-select:none}
.aeb-panel{border-radius:32px}
.aeb-panel-content{display:flex;flex-direction:column;flex-shrink:0;min-height:0;max-height:inherit;width:100%}
.aeb-ai-bubble.aeb-answer-active{background:var(--aeb-highlight);color:var(--aeb-fg)}
.aeb-ai-bubble .aeb-answerline.aeb-active{background:transparent;border-radius:0}
.aeb-ai-message{max-width:92%}
.aeb-ai-bubble{padding:0}
.aeb-ai-bubble .aeb-answerline{padding:10px 13px}
</style>
