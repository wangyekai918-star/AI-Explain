import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import AiExplainBot from './AiExplainBot.ce.vue'
import { patchExposedToElement, registerAiExplainBot, TeldAiExplainElement } from './customElement'
import { themeFromColor } from './themes'
import type { ExplainController, ExplainStateSnapshot } from '../core/ExplainController'

enableAutoUnmount(afterEach)

const baseSnapshot = (overrides: Partial<ExplainStateSnapshot> = {}): ExplainStateSnapshot => ({
  phase: 'idle',
  answerStatus: 'none',
  voiceState: 'idle',
  questionText: '',
  answerText: '',
  answerLines: [],
  answerLineIndex: -1,
  dialogGroups: [],
  activeGroupId: null,
  lines: [],
  lineStarts: [],
  currentLineIndex: -1,
  currentTime: 0,
  duration: 0,
  robotConfig: null,
  isInterruptEnabled: true,
  error: null,
  ...overrides,
})

const createBotMock = (snapshot: ExplainStateSnapshot = baseSnapshot()) => {
  const listeners = new Set<(s: ExplainStateSnapshot) => void>()
  return {
    snapshot,
    listeners,
    emit (overrides: Partial<ExplainStateSnapshot>) {
      snapshot = { ...snapshot, ...overrides }
      for (const l of listeners) l(snapshot)
    },
    start: vi.fn(async () => {}),
    loadRobotConfig: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    playLine: vi.fn(async () => {}),
    seekTo: vi.fn(async () => {}),
    seekBy: vi.fn(async () => {}),
    setRate: vi.fn(),
    restart: vi.fn(async () => {}),
    askText: vi.fn(async () => {}),
    replayAnswer: vi.fn(),
    startVoiceInput: vi.fn(async () => {}),
    stopVoiceInput: vi.fn(async () => {}),
    handleControlIntent: vi.fn(),
    setVisible: vi.fn(),
    resumeMainTrack: vi.fn(),
    destroy: vi.fn(),
    subscribe: (listener: (s: ExplainStateSnapshot) => void) => {
      listeners.add(listener)
      listener(snapshot)
      return () => listeners.delete(listener)
    },
  } as unknown as ExplainController & { emit: (o: Partial<ExplainStateSnapshot>) => void, snapshot: ExplainStateSnapshot }
}

describe('AiExplainBot 组件', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.localStorage.removeItem('aeb:panel-mode:v1')
  })

  it('记住展开/迷你模式，关闭重开和重新挂载都恢复最近选择', async () => {
    const wrapper = mount(AiExplainBot, { props: { bot: createBotMock() } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(wrapper.find('.aeb-mini').exists()).toBe(true)
    await wrapper.find('[aria-label="展开"]').trigger('click')
    await wrapper.find('[aria-label="关闭"]').trigger('click')
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(wrapper.find('.aeb-panel').exists()).toBe(true)
    wrapper.unmount()
    const restored = mount(AiExplainBot, { props: { bot: createBotMock() } })
    await flushPromises()
    await restored.find('.aeb-avatar').trigger('click')
    expect(restored.find('.aeb-panel').exists()).toBe(true)
    await restored.find('[aria-label="收起"]').trigger('click')
    await restored.find('[aria-label="关闭"]').trigger('click')
    await restored.find('.aeb-avatar').trigger('click')
    expect(restored.find('.aeb-mini').exists()).toBe(true)
    expect(window.localStorage.getItem('aeb:panel-mode:v1')).toBe('mini')
  })

  it('idle 渲染形象入口，theme 落到根节点 data-theme', async () => {
    const wrapper = mount(AiExplainBot, { props: { bot: createBotMock(), theme: 'dark' } })
    await flushPromises() // 浮动图标在 loadRobotConfig 落定后才显示
    expect(wrapper.find('.aeb-avatar').exists()).toBe(true)
    expect(wrapper.find('.aeb-root').attributes('data-theme')).toBe('dark')
  })

  it('点击形象打开迷你浮层并发起 start（含状态文案映射）', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'generating' }))
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001', scenarioName: '经营报告' } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(bot.start).toHaveBeenCalled()
    expect(wrapper.find('[part="mini-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('AI 讲解 · 经营报告')
    expect(wrapper.text()).toContain('正在分析内容…')
  })

  it('展开面板渲染字幕行并高亮当前句，关闭时发出 bot-close', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'playing',
      lines: [
        { lineId: 'l1', speaker: 'A', text: '第一句' },
        { lineId: 'l2', speaker: 'B', text: '第二句' },
      ],
      lineStarts: [0, 1.2],
      currentLineIndex: 1,
      duration: 2.4,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    expect(wrapper.find('[part="panel"]').exists()).toBe(true)
    const items = wrapper.findAll('.aeb-line')
    expect(items).toHaveLength(2)
    expect(items[1].classes()).toContain('aeb-active')
    expect(items[1].text()).toContain('小特')
    expect(wrapper.find('.aeb-stamp').exists()).toBe(false)
    await items[1].trigger('click')
    expect(bot.playLine).toHaveBeenCalledWith(1)
    await items[0].trigger('keydown', { key: 'Enter' })
    expect(bot.playLine).toHaveBeenCalledWith(0)

    await wrapper.find('[aria-label="关闭"]').trigger('click')
    expect(wrapper.emitted('bot-close')).toHaveLength(1)
    expect(wrapper.find('.aeb-avatar').exists()).toBe(true)
  })

  it('字幕角色名取 voiceSetting.displayName 覆盖内置名', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'playing',
      robotConfig: {
        voiceSetting: { roleDivisionId: '1', voices: [
          { role: 'A', displayName: '电小智', answerQuestion: true },
          { role: 'B', displayName: '特小慧' },
        ] },
      },
      lines: [
        { lineId: 'l1', speaker: 'A', text: '第一句' },
        { lineId: 'l2', speaker: 'B', text: '第二句' },
      ],
      lineStarts: [0, 1.2],
      currentLineIndex: 0,
      duration: 2.4,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    const items = wrapper.findAll('.aeb-line')
    expect(items[0].text()).toContain('电小智')
    expect(items[1].text()).toContain('特小慧')
  })

  it('isInterrupt=false 时不渲染提问区', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing', isInterruptEnabled: false, lines: [{ lineId: 'l1', speaker: 'A', text: 'x' }], duration: 1.2 }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    expect(wrapper.find('[part="ask-bar"]').exists()).toBe(false)
  })

  it('文本提问发出 bot-ask 并调用控制器', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing', lines: [{ lineId: 'l1', speaker: 'A', text: 'x' }], duration: 1.2 }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    await wrapper.find('input').setValue('为什么增长')
    await wrapper.find('.aeb-send').trigger('click')
    expect(wrapper.emitted('bot-ask')![0]).toEqual(['为什么增长'])
    expect(bot.askText).toHaveBeenCalledWith('为什么增长')
  })

  it('浮动图标在配置落定前不渲染，落定后显示（防配置到达跳变）', async () => {
    const bot = createBotMock()
    let resolveConfig: () => void = () => {}
    bot.loadRobotConfig = vi.fn(() => new Promise<void>(r => { resolveConfig = r }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    expect(wrapper.find('.aeb-avatar').exists()).toBe(false)
    resolveConfig()
    await flushPromises()
    expect(wrapper.find('.aeb-avatar').exists()).toBe(true)
  })

  it('关闭浮层通知控制器隐藏（停播），重开通知可见（续播）', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="关闭"]').trigger('click')
    expect(wrapper.emitted('bot-close')).toHaveLength(1)
    expect(bot.setVisible).toHaveBeenLastCalledWith(false)
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(bot.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('显式 theme 用预制配色；未传 theme 时随 themeColor 亮度判定', async () => {
    const bot = createBotMock(baseSnapshot({
      robotConfig: { robotSet: { themeColor: '#0a1c38', backgroundColor: '#0a1c38' } },
    }))
    // 显式 light：robotSet 颜色不再覆盖预制 token（backgroundColor 也不消费）
    const explicit = mount(AiExplainBot, { props: { bot, theme: 'light' } })
    await flushPromises()
    expect(explicit.find('.aeb-root').attributes('data-theme')).toBe('light')
    expect(explicit.find('.aeb-root').attributes('style') || '').not.toContain('#0a1c38')
    explicit.unmount()
    // 未传 theme：深色 themeColor → dark 预制
    const auto = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    expect(auto.find('.aeb-root').attributes('data-theme')).toBe('dark')
    auto.unmount()
  })

  it('回答播报时主按钮可暂停，同一回答点击暂停而不重复重播', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'answering', answerStatus: 'playing', activeGroupId: 'g1',
      dialogGroups: dialogGroupsFixture.map(g => ({ ...g, done: false })),
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    const pause = wrapper.find('[aria-label="暂停"]')
    expect(pause.attributes('disabled')).toBeUndefined()
    await pause.trigger('click')
    expect(bot.pause).toHaveBeenCalledTimes(1)
    await wrapper.find('[aria-label="播放这条回答"]').trigger('click')
    expect(bot.pause).toHaveBeenCalledTimes(2)
    expect(bot.replayAnswer).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('回答暂停中：主控播放键可用且继续当前回答，状态文案「回答已暂停」', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'answering',
      answerStatus: 'paused',
      activeGroupId: 'g1',
      dialogGroups: dialogGroupsFixture,
      lines: [{ lineId: 'l1', speaker: 'A', text: '主轨' }],
      lineStarts: [0],
      duration: 6,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    expect(wrapper.text()).toContain('回答已暂停')
    // 主控播放键继续当前回答，不再切回主讲解。
    const playBtn = wrapper.find('[aria-label="播放"]')
    expect(playBtn.attributes('disabled')).toBeUndefined()
    await playBtn.trigger('click')
    expect(bot.play).toHaveBeenCalled()
    expect(bot.resumeMainTrack).not.toHaveBeenCalled()
    // 追问入口同步放宽：输入框/语音/发送在回答暂停中可用
    expect(wrapper.find('.aeb-input').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[aria-label="点击说话"]').attributes('disabled')).toBeUndefined()
    const submitBtn = wrapper.find('.aeb-send')
    expect(submitBtn.attributes('disabled')).toBeDefined() // 空输入仍禁用发送
  })

  it('错误提示脱敏 toast:界面只提示异常,具体原因输出到控制台,5s 自动隐藏', async () => {
    vi.useFakeTimers()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bot = createBotMock(baseSnapshot({ phase: 'error', error: { kind: 'generate-failed', message: '内部详细原因XYZ' } }))
      const wrapper = mount(AiExplainBot, { props: { bot } })
      await flushPromises()
      const tip = wrapper.find('.aeb-error')
      expect(tip.exists()).toBe(true)
      expect(tip.text()).toContain('讲解出现异常')
      expect(tip.text()).not.toContain('内部详细原因XYZ') // 具体原因不上界面
      expect(errSpy).toHaveBeenCalled() // 具体原因进控制台
      const logged = errSpy.mock.calls.flat().find(a => typeof a === 'object' && a !== null) as { message?: string } | undefined
      expect(logged?.message).toContain('内部详细原因XYZ')
      vi.advanceTimersByTime(4999)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.aeb-error').exists()).toBe(true) // 5s 内保持
      vi.advanceTimersByTime(1)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.aeb-error').exists()).toBe(false) // 5s 到自动隐藏
    } finally {
      errSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('bot-theme 外泄运行时主题：显式 theme 与 themeColor 判定都派发', async () => {
    const bot = createBotMock(baseSnapshot({
      robotConfig: { robotSet: { themeColor: '#0a1c38', backgroundColor: '#0a1c38' } },
    }))
    // 显式 light：立即派发 light（themeColor 深色也不改判）
    const explicit = mount(AiExplainBot, { props: { bot, theme: 'light' } })
    await flushPromises()
    expect(explicit.emitted('bot-theme')!.at(-1)).toEqual(['light'])
    explicit.unmount()
    // 未传 theme：深色 themeColor → dark（CE 自行判定的运行时主题）
    const auto = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    expect(auto.emitted('bot-theme')!.at(-1)).toEqual(['dark'])
    auto.unmount()
  })

  it('气泡不重复显示讲解人，保留读屏身份描述', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'playing',
      robotConfig: {
        voiceSetting: { voices: [
          { role: 'A', displayName: '电小智', answerQuestion: true },
          { role: 'B', displayName: '数字员工特小慧' },
        ] },
      },
      lines: [
        { lineId: 'l1', speaker: 'A', text: '第一句' },
        { lineId: 'l2', speaker: 'B', text: '第二句' },
      ],
      lineStarts: [0, 1.2],
      currentLineIndex: 0,
      duration: 2.4,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    const speakers = wrapper.findAll('.aeb-speaker')
    expect(speakers).toHaveLength(2)
    expect(speakers[0].classes()).toContain('aeb-sr-only')
    expect(speakers[1].classes()).toContain('aeb-sr-only')
    expect(wrapper.find('[part="panel-header"] .aeb-header-avatar').exists()).toBe(true)
    expect(wrapper.findAll('.aeb-chat-orb')).toHaveLength(0)
  })

  it('追问问答按组入对话流：问题在组头，回答行随逐行播报高亮，主轨行不让位', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'answering',
      answerStatus: 'playing',
      questionText: '还有什么需要考虑的吗',
      lines: [
        { lineId: 'l1', speaker: 'A', text: '主轨第一句' },
        { lineId: 'l2', speaker: 'B', text: '主轨第二句' },
      ],
      currentLineIndex: 1, // 主轨停在断点行
      activeGroupId: 'g1',
      dialogGroups: [{
        id: 'g1',
        question: '还有什么需要考虑的吗',
        source: 'text',
        lines: [
          { lineId: 'answer-1', speaker: 'A', text: '补充一点，报告里还藏着两个观察点。' },
          { lineId: 'answer-2', speaker: 'B', text: '哦？展开说说。' },
        ],
        fromDoc: true,
        done: false,
        breakpoint: 1.2,
      }],
      answerLineIndex: 1,
      robotConfig: {
        voiceSetting: { voices: [
          { role: 'A', displayName: '电小智', answerQuestion: true },
          { role: 'B', displayName: '特小慧' },
        ] },
      },
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    // 问答在对话（字幕）流内分组展示，不再有独立回答气泡
    expect(wrapper.find('[part="answer-bubble"]').exists()).toBe(false)
    const heads = wrapper.findAll('.aeb-group-head')
    expect(heads).toHaveLength(1)
    expect(heads[0].text()).toContain('还有什么需要考虑的吗')
    const answerItems = wrapper.findAll('.aeb-answerline')
    expect(answerItems).toHaveLength(2)
    expect(answerItems[0].text()).toContain('电小智')
    expect(answerItems[1].text()).toContain('特小慧')
    expect(answerItems[1].classes()).toContain('aeb-active') // 正在播报的回答行高亮
    // 回答播报期主轨行不让位高亮（同一时刻只有回答行一个高亮，滚动定位才正确）
    const mainItems = wrapper.findAll('.aeb-subtitles > .aeb-line:not(.aeb-answerline):not(.aeb-askline)')
    expect(mainItems[1].classes()).not.toContain('aeb-active')
  })

  /* ── 追问对话分组：折叠/重播/来源标记 + 进度条打断点标记 ── */
  const dialogGroupsFixture = [
    { id: 'g1', question: '第一问', source: 'text' as const, lines: [{ lineId: 'answer-1', speaker: 'A', text: '答一。' }], fromDoc: false, done: true, breakpoint: 1.5 },
    { id: 'g2', question: '第二问', source: 'voice' as const, lines: [{ lineId: 'answer-2', speaker: 'B', text: '答二。' }], fromDoc: false, done: true, breakpoint: 3 },
  ]

  it('多次追问按组展示：组头问题/来源，组可折叠，收口组显示重播按钮', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'ended',
      lines: [{ lineId: 'l1', speaker: 'A', text: '主轨' }],
      lineStarts: [0],
      duration: 6,
      dialogGroups: dialogGroupsFixture,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    const heads = wrapper.findAll('.aeb-group-head')
    expect(heads).toHaveLength(2)
    expect(heads[0].text()).toContain('第一问')
    expect(heads[0].find('.aeb-group-src').attributes('aria-label')).toBe('文字提问')
    expect(heads[1].find('.aeb-group-src').attributes('aria-label')).toBe('语音提问')
    expect(wrapper.find('.aeb-group-replay').exists()).toBe(false)
    expect(wrapper.find('.aeb-group-toggle').exists()).toBe(false)
    const bubbles = wrapper.findAll('[aria-label="播放这条回答"]')
    await bubbles[0].trigger('click')
    expect(bot.replayAnswer).toHaveBeenCalledWith('g1')
    await heads[0].trigger('click')
    expect(wrapper.text()).toContain('答一。') // 用户消息不再触发折叠

  })

  it('活动组未收口不显示重播按钮；分析中显示提示文案，回答行到位后高亮', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'answering',
      answerStatus: 'analyzing',
      activeGroupId: 'g2',
      dialogGroups: [
        dialogGroupsFixture[0],
        { id: 'g2', question: '第二问', source: 'voice', lines: [], fromDoc: false, done: false, breakpoint: 3 },
      ],
      lines: [{ lineId: 'l1', speaker: 'A', text: '主轨' }],
      lineStarts: [0],
      duration: 6,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    expect(wrapper.find('.aeb-group-replay').exists()).toBe(false)
    expect(wrapper.text()).toContain('正在思考…')
    // 回答 durable 定稿入组 → 播报推进高亮
    bot.emit({
      answerStatus: 'playing',
      answerLineIndex: 0,
      dialogGroups: [dialogGroupsFixture[0], { ...dialogGroupsFixture[1], done: false }],
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('正在思考…')
    expect(wrapper.findAll('.aeb-answerline')[1].classes()).toContain('aeb-active')
  })

  it('回答播报收口后保留展开（问题、回答与重播按钮均可回看）', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'answering',
      answerStatus: 'playing',
      answerLineIndex: 0,
      activeGroupId: 'g1',
      dialogGroups: [
        { id: 'g1', question: '第一问', source: 'text', lines: [{ lineId: 'answer-1', speaker: 'A', text: '答一。' }], fromDoc: false, done: false, breakpoint: 1.5 },
      ],
      lines: [{ lineId: 'l1', speaker: 'A', text: '主轨' }],
      lineStarts: [0],
      duration: 6,
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    expect(wrapper.text()).toContain('答一。') // 播报中组体展开
    // 收口:活动组落定 → 自动折叠该组
    bot.emit({
      answerStatus: 'none',
      answerLineIndex: -1,
      activeGroupId: null,
      phase: 'playing',
      dialogGroups: [{ ...bot.snapshot.dialogGroups[0], done: true }],
    })
    await flushPromises()
    expect(wrapper.text()).toContain('答一。') // 回答保留展开
    const head = wrapper.find('.aeb-group-head')
    expect(head.exists()).toBe(true) // 组头保留(问题摘要可见)
    expect(wrapper.find('[aria-label="播放这条回答"]').exists()).toBe(true) // 气泡播放入口保留
  })

  it('进度条按打断点分布显示序号标记，点击跳转断点', async () => {
    const bot = createBotMock(baseSnapshot({
      phase: 'paused',
      lines: [{ lineId: 'l1', speaker: 'A', text: '主轨' }],
      lineStarts: [0],
      duration: 6,
      dialogGroups: dialogGroupsFixture, // 断点 1.5/6=25%、3/6=50%
    }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    const markers = wrapper.findAll('.aeb-progress-marker')
    expect(markers).toHaveLength(2)
    expect(markers[0].attributes('style')).toContain('left: 25%')
    expect(markers[1].attributes('style')).toContain('left: 50%')
    expect(markers[0].attributes('title')).toContain('第一问')
    await markers[0].trigger('click')
    expect(bot.seekTo).toHaveBeenCalledWith(1.5) // 跳转该组打断点
  })

  it('播放推进时字幕滚动跟随高亮行，用户滚动后暂停跟随', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const bot = createBotMock(baseSnapshot({
        phase: 'playing',
        lines: [
          { lineId: 'l1', speaker: 'A', text: '一' },
          { lineId: 'l2', speaker: 'A', text: '二' },
          { lineId: 'l3', speaker: 'A', text: '三' },
        ],
        lineStarts: [0, 1.2, 2.4],
        currentLineIndex: 0,
        duration: 3.6,
      }))
      const wrapper = mount(AiExplainBot, { props: { bot } })
      await flushPromises()
      await wrapper.find('.aeb-avatar').trigger('click')
      await wrapper.find('[aria-label="展开"]').trigger('click')
      scrollIntoView.mockClear()
      bot.emit({ currentLineIndex: 2 }) // 高亮行推进 → 滚动跟随
      await flushPromises()
      expect(scrollIntoView).toHaveBeenCalled()
      // 用户手动滚动 → 暂停自动跟随
      scrollIntoView.mockClear()
      await wrapper.find('.aeb-subtitles').trigger('wheel')
      bot.emit({ currentLineIndex: 0 })
      await flushPromises()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  /* ── 浮动图标拖拽 / 关闭（jsdom 无 PointerEvent 构造器，用 MouseEvent 携带坐标） ── */
  const pointerDown = (el: Element, x: number, y: number) =>
    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }))
  const pointerMove = (x: number, y: number) =>
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))
  const pointerUp = () => window.dispatchEvent(new MouseEvent('pointerup', {}))

  it('avatar-draggable="true" 可拖动：拖动更新内联位置且收尾 click 不发起讲解', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001', avatarDraggable: 'true' } })
    await flushPromises()
    pointerDown(wrapper.find('.aeb-avatar').element, 100, 200)
    pointerMove(130, 200)
    pointerUp()
    await flushPromises()
    // jsdom 视口尺寸为 0 不裁剪：基准(0,0)+位移(30,0)
    const style = wrapper.find('.aeb-avatar-wrap').attributes('style') || ''
    expect(style).toContain('position: fixed')
    expect(style).toContain('left: 30px')
    // 拖动结束的收尾 click 被吞掉，不发起讲解
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(bot.start).not.toHaveBeenCalled()
    // 标志已消费，再次点击正常发起
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(bot.start).toHaveBeenCalled()
  })

  it('缺省不可拖动：拖动无效且 click 照常发起讲解', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001' } })
    await flushPromises()
    pointerDown(wrapper.find('.aeb-avatar').element, 100, 200)
    pointerMove(130, 200)
    pointerUp()
    await flushPromises()
    expect(wrapper.find('.aeb-avatar-wrap').attributes('style')).toBeUndefined()
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(bot.start).toHaveBeenCalled()
  })

  it('robotSet.ext.avatarDraggable 回落生效；attribute 显式 false 优先', async () => {
    const snapshot = baseSnapshot({ robotConfig: { robotSet: { ext: { avatarDraggable: true } } } })
    const bot = createBotMock(snapshot)
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001' } })
    await flushPromises()
    pointerDown(wrapper.find('.aeb-avatar').element, 100, 200)
    pointerMove(120, 210)
    pointerUp()
    await flushPromises()
    expect(wrapper.find('.aeb-avatar-wrap').attributes('style') || '').toContain('position: fixed')
    wrapper.unmount()

    const bot2 = createBotMock(snapshot)
    const wrapper2 = mount(AiExplainBot, { props: { bot: bot2, configId: '1001', avatarDraggable: 'false' } })
    await flushPromises()
    pointerDown(wrapper2.find('.aeb-avatar').element, 100, 200)
    pointerMove(130, 200)
    pointerUp()
    await flushPromises()
    expect(wrapper2.find('.aeb-avatar-wrap').attributes('style')).toBeUndefined()
  })

  it('avatar-draggable 支持 boolean 传参：true 可拖，显式 false 压过 ext 配置', async () => {
    const snapshot = baseSnapshot({ robotConfig: { robotSet: { ext: { avatarDraggable: true } } } })
    const bot = createBotMock(snapshot)
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001', avatarDraggable: true } })
    await flushPromises()
    pointerDown(wrapper.find('.aeb-avatar').element, 100, 200)
    pointerMove(120, 210)
    pointerUp()
    await flushPromises()
    expect(wrapper.find('.aeb-avatar-wrap').attributes('style') || '').toContain('position: fixed')
    wrapper.unmount()

    const bot2 = createBotMock(snapshot)
    const wrapper2 = mount(AiExplainBot, { props: { bot: bot2, configId: '1001', avatarDraggable: false } })
    await flushPromises()
    pointerDown(wrapper2.find('.aeb-avatar').element, 100, 200)
    pointerMove(130, 200)
    pointerUp()
    await flushPromises()
    expect(wrapper2.find('.aeb-avatar-wrap').attributes('style')).toBeUndefined()
  })

  it('位移未超阈值（5px）视为点击，照常发起讲解', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001', avatarDraggable: 'true' } })
    await flushPromises()
    pointerDown(wrapper.find('.aeb-avatar').element, 100, 200)
    pointerMove(102, 201)
    pointerUp()
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    expect(bot.start).toHaveBeenCalled()
  })

  it('show-avatar="false" 隐藏浮动形象入口（含关闭角标），容器保留', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001', showAvatar: 'false' } })
    await flushPromises()
    expect(wrapper.find('.aeb-avatar-wrap').exists()).toBe(false)
    expect(wrapper.find('.aeb-root').exists()).toBe(true)
  })

  it('暴露的 start() 打开面板并发起讲解；已有稿件时只恢复面板不重播', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001' } })
    await flushPromises()
    await (wrapper.vm as unknown as { start?: () => Promise<void> }).start?.()
    await flushPromises()
    expect(wrapper.emitted('bot-start')).toHaveLength(1)
    expect(bot.start).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[part="mini-panel"]').exists()).toBe(true)
    wrapper.unmount()

    // 已有稿件（ended 态）：只恢复面板，不重复发起
    const bot2 = createBotMock(baseSnapshot({
      phase: 'ended',
      lines: [{ lineId: 'l1', speaker: 'A', text: '第一句' }],
      lineStarts: [0],
      duration: 1.2,
    }))
    const wrapper2 = mount(AiExplainBot, { props: { bot: bot2, configId: '1001' } })
    await flushPromises()
    await (wrapper2.vm as unknown as { start?: () => Promise<void> }).start?.()
    await flushPromises()
    expect(bot2.start).not.toHaveBeenCalled()
    expect(wrapper2.find('[part="mini-panel"]').exists()).toBe(true)
  })

  it('浮动图标 ✕ 隐藏整个组件（停播 + bot-dismiss），open() 恢复显示', async () => {
    const bot = createBotMock()
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001' } })
    await flushPromises()
    await wrapper.find('.aeb-avatar-close').trigger('click')
    expect(wrapper.find('.aeb-root').exists()).toBe(false)
    expect(bot.setVisible).toHaveBeenLastCalledWith(false)
    expect(wrapper.emitted('bot-dismiss')).toHaveLength(1)
    ;(wrapper.vm as { open: () => void }).open()
    await flushPromises()
    // open() 既有语义 = 展开浮层（面板形态），图标不再渲染
    expect(wrapper.find('.aeb-root').exists()).toBe(true)
    expect(wrapper.find('[part="mini-panel"]').exists()).toBe(true)
    expect(bot.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('有对话后主轨恢复不抢回旧字幕；手动滚动仍可暂停跟随', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing', lines: [{ lineId: 'l1', speaker: 'A', text: '主轨' }], currentLineIndex: -1, dialogGroups: dialogGroupsFixture }))
    const wrapper = mount(AiExplainBot, { props: { bot } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    await wrapper.find('[aria-label="展开"]').trigger('click')
    const list = wrapper.find('.aeb-subtitles')
    Object.defineProperty(list.element, 'scrollHeight', { value: 1000, configurable: true })
    bot.emit({ currentLineIndex: 0 })
    await flushPromises()
    expect(list.element.scrollTop).toBe(1000)
    await list.trigger('wheel')
    list.element.scrollTop = 200
    bot.emit({ currentLineIndex: -1 })
    await flushPromises()
    expect(list.element.scrollTop).toBe(200)
  })

  /* ── 点击录音：开始 / 结束 / 显式取消 ── */
  const openVoiceView = async (bot: ReturnType<typeof createBotMock>, expanded = true, props = {}) => {
    const wrapper = mount(AiExplainBot, { props: { bot, configId: '1001', ...props } })
    await flushPromises()
    await wrapper.find('.aeb-avatar').trigger('click')
    if (expanded) await wrapper.find('[aria-label="展开"]').trigger('click')
    return wrapper
  }
  const beginRecording = async (wrapper: ReturnType<typeof mount>, bot: ReturnType<typeof createBotMock>) => {
    await wrapper.find('[aria-label="点击说话"]').trigger('click')
    bot.emit({ phase: 'paused', voiceState: 'recording' })
    await flushPromises()
  }

  it('点击说话开始录音，松开鼠标不会结束；显示独立结束与取消按钮', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    const wrapper = await openVoiceView(bot)
    const mic = wrapper.find('[aria-label="点击说话"]')
    await mic.trigger('pointerdown')
    expect(bot.startVoiceInput).not.toHaveBeenCalled()
    await beginRecording(wrapper, bot)
    expect(bot.startVoiceInput).toHaveBeenCalledTimes(1)
    await wrapper.find('[part="recording-bar"]').trigger('pointerup')
    expect(bot.stopVoiceInput).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-label="结束并发送"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="取消录音"]').exists()).toBe(true)
    expect(wrapper.text()).not.toMatch(/上滑|松开/)
  })

  it('默认点击结束即提交一次，识别期间不可重复结束或提交文字', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    let resolveStop!: () => void
    bot.stopVoiceInput = vi.fn(() => new Promise<void>(resolve => { resolveStop = resolve }))
    const wrapper = await openVoiceView(bot)
    await beginRecording(wrapper, bot)
    await wrapper.find('[aria-label="结束并发送"]').trigger('click')
    expect(bot.stopVoiceInput).toHaveBeenCalledTimes(1)
    expect(bot.stopVoiceInput).toHaveBeenCalledWith()
    expect(wrapper.find('[aria-label="结束并发送"]').exists()).toBe(false)
    expect(wrapper.find('.aeb-input').exists()).toBe(false)
    expect(wrapper.text()).toContain('正在识别语音')
    resolveStop()
    bot.emit({ voiceState: 'idle' })
    await flushPromises()
  })

  it('取消录音只丢弃录音，不识别、不发送追问', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    const wrapper = await openVoiceView(bot)
    await beginRecording(wrapper, bot)
    await wrapper.find('[aria-label="取消录音"]').trigger('click')
    expect(bot.stopVoiceInput).toHaveBeenCalledWith({ cancel: true })
    expect(bot.askText).not.toHaveBeenCalled()
  })

  it('Esc 可以取消正在录制的语音', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    const wrapper = await openVoiceView(bot)
    await beginRecording(wrapper, bot)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(bot.stopVoiceInput).toHaveBeenCalledWith({ cancel: true })
  })

  it('麦克风权限等待期间只允许一次开始；取消后就绪立即释放', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    let resolveStart!: () => void
    bot.startVoiceInput = vi.fn(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const wrapper = await openVoiceView(bot)
    const mic = wrapper.find('[aria-label="点击说话"]')
    await mic.trigger('click')
    expect(wrapper.text()).toContain('正在准备麦克风')
    expect(wrapper.find('[aria-label="点击说话"]').exists()).toBe(false)
    expect(bot.startVoiceInput).toHaveBeenCalledTimes(1)
    await wrapper.find('[aria-label="取消录音"]').trigger('click')
    expect(bot.stopVoiceInput).not.toHaveBeenCalled()
    bot.emit({ voiceState: 'recording' })
    resolveStart()
    await flushPromises()
    expect(bot.stopVoiceInput).toHaveBeenCalledWith({ cancel: true })
  })

  it('录音时关闭浮窗会取消录音并隐藏播放器', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    const wrapper = await openVoiceView(bot)
    await beginRecording(wrapper, bot)
    await wrapper.find('[aria-label="关闭"]').trigger('click')
    expect(bot.setVisible).toHaveBeenCalledWith(false)
    expect(bot.stopVoiceInput).toHaveBeenCalledWith({ cancel: true })
  })

  it('麦克风就绪前关闭浮窗，也会在就绪后丢弃录音', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    let resolveStart!: () => void
    bot.startVoiceInput = vi.fn(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const wrapper = await openVoiceView(bot)
    await wrapper.find('[aria-label="点击说话"]').trigger('click')
    await wrapper.find('[aria-label="关闭"]').trigger('click')
    bot.emit({ voiceState: 'recording' })
    resolveStart()
    await flushPromises()
    expect(bot.stopVoiceInput).toHaveBeenCalledWith({ cancel: true })
  })

  it('迷你与展开切换保留同一次录音，展开后仍可结束', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    const wrapper = await openVoiceView(bot, false)
    await beginRecording(wrapper, bot)
    await wrapper.find('[aria-label="展开"]').trigger('click')
    expect(bot.startVoiceInput).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[aria-label="结束并发送"]').exists()).toBe(true)
    await wrapper.find('[aria-label="结束并发送"]').trigger('click')
    expect(bot.stopVoiceInput).toHaveBeenCalledWith()
  })

  it('宿主显式配置 fill 时结束录音只回填，不自动发送', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    bot.stopVoiceInput = vi.fn(async () => { bot.emit({ voiceState: 'idle' }); return { text: '补充一个观点' } }) as never
    const wrapper = await openVoiceView(bot, true, { voiceSendMode: 'fill' })
    await beginRecording(wrapper, bot)
    await wrapper.find('[aria-label="结束录音"]').trigger('click')
    await flushPromises()
    expect(bot.stopVoiceInput).toHaveBeenCalledWith({ ask: false })
    expect((wrapper.find('.aeb-input').element as HTMLInputElement).value).toBe('补充一个观点')
    expect(bot.askText).not.toHaveBeenCalled()
  })

  it('无追问权限时迷你浮层也不显示说话入口', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing', isInterruptEnabled: false }))
    const wrapper = await openVoiceView(bot, false)
    expect(wrapper.find('[aria-label="点击说话"]').exists()).toBe(false)
  })

  it('准备期禁用说话；录音期间也禁用播放控制', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'generating' }))
    const wrapper = await openVoiceView(bot)
    expect(wrapper.find('[aria-label="点击说话"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[aria-label="点击说话"]').trigger('click')
    expect(bot.startVoiceInput).not.toHaveBeenCalled()
    bot.emit({ phase: 'playing' })
    await flushPromises()
    await beginRecording(wrapper, bot)
    expect(wrapper.find('[aria-label="播放"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[aria-label="快退"]').attributes('disabled')).toBeDefined()
  })

  it('输入与录音共用紧凑胶囊，音量回调驱动真实声波', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'playing' }))
    const wrapper = await openVoiceView(bot)
    expect(wrapper.find('.aeb-presence').exists()).toBe(false)
    expect(wrapper.find('.aeb-click-mic').text()).toBe('')
    expect(wrapper.find('[aria-label="字幕开关"]').text()).toBe('字幕')
    await beginRecording(wrapper, bot)
    expect(wrapper.find('.aeb-voice-capsule').exists()).toBe(true)
    expect(wrapper.find('.aeb-record-cancel svg').exists()).toBe(true)
    expect(wrapper.find('.aeb-record-finish svg').exists()).toBe(true)
    const opts = vi.mocked(bot.startVoiceInput).mock.calls[0][0]!
    opts.onLevel!(0.15)
    await flushPromises()
    expect(wrapper.findAll('.aeb-waveform > span').at(-1)!.attributes('style')).toContain('19.5px')
    expect(wrapper.findAll('.aeb-waveform > span')[0].attributes('style')).toContain('3px')
  })

  it('用户与 AI 有明确身份，主讲解也标为 AI，回答不自动隐藏', async () => {
    const bot = createBotMock(baseSnapshot({ phase: 'ended', lines: [{ lineId: 'l1', speaker: 'A', text: '主讲解' }], dialogGroups: dialogGroupsFixture }))
    const wrapper = await openVoiceView(bot)
    expect(wrapper.find('.aeb-user-message').text()).toContain('我')
    expect(wrapper.find('.aeb-user-message').text()).toContain('第一问')
    expect(wrapper.find('.aeb-user-message').text()).not.toContain('答一。')
    expect(wrapper.find('.aeb-ai-message .aeb-speaker').text()).toContain('AI ·')
    expect(wrapper.find('.aeb-ai-message').text()).toContain('答一。')
    expect(wrapper.find('.aeb-subtitles > .aeb-line .aeb-speaker').text()).toContain('AI')
  })

})

describe('themeFromColor', () => {
  it('hex 按亮度判定；非十六进制字面量原样返回；空值为 null', () => {
    expect(themeFromColor('#1e88e5')).toBe('light') // 品牌蓝（light 预制自己的点缀色）
    expect(themeFromColor('#0a1c38')).toBe('dark') // 大屏深蓝
    expect(themeFromColor('#FFF')).toBe('light') // 3 位缩写
    expect(themeFromColor('dark')).toBe('dark') // themeColor 直填主题字面量
    expect(themeFromColor('blue')).toBe('blue') // 非法 key：由 CE 侧校验兜底 light
    expect(themeFromColor(undefined)).toBeNull()
  })
})

describe('registerAiExplainBot', () => {
  it('幂等注册自定义元素', () => {
    const defineSpy = vi.spyOn(customElements, 'define')
    registerAiExplainBot('teld-ai-explain-test')
    registerAiExplainBot('teld-ai-explain-test')
    expect(customElements.get('teld-ai-explain-test')).toBe(TeldAiExplainElement)
    expect(defineSpy).toHaveBeenCalledTimes(1)
  })

  it('老运行时兜底：patchExposedToElement 把内部 exposed 补挂到元素实例（不覆盖已有成员）', () => {
    const start = vi.fn()
    const el = document.createElement('div') as HTMLElement & { _instance?: unknown, start?: unknown, scenario?: unknown }
    ;(el as { _instance: unknown })._instance = { exposed: { start, scenario: 'from-expose' } }
    ;(el as { scenario?: unknown }).scenario = 'injected'
    patchExposedToElement(el)
    expect(el.start).toBe(start)
    expect(el.scenario).toBe('injected')
  })

  it('声明 props 的 accessor（如 bot）不被 expose 补挂污染：getter undefined 也不得触发 setter', () => {
    // 线上 3.3.4 机制复现：VueElement 给声明 props 定义 accessor，set 会写进组件 props.bot，
    // 导致 ensureBot 把 exposed 的 computed 当控制器返回（bot.start is not a function）
    const el = document.createElement('div') as HTMLElement & { _instance?: unknown }
    let written: unknown
    Object.defineProperty(el, 'bot', {
      get: () => undefined, // 未注入 → getter 返回 undefined
      set: (v) => { written = v },
      configurable: true,
    })
    ;(el as { _instance: unknown })._instance = { exposed: { bot: {}, start: vi.fn() } }
    patchExposedToElement(el)
    expect(written).toBeUndefined()
    expect((el as unknown as { start?: unknown }).start).toBeDefined()
  })

  it('connectedCallback 后 expose 成员挂到元素实例（el.start/el.open 可用）', async () => {
    // 同一元素类不能注册第二个 tag，复用幂等用例注册的 tag（registerAiExplainBot 幂等，重复调用安全）
    const tag = 'teld-ai-explain-test'
    registerAiExplainBot(tag)
    const el = document.createElement(tag) as HTMLElement & { bot?: unknown, start?: unknown, open?: unknown }
    // property 注入 bot：走组件的注入形态，避免自建 controller 发起真实请求
    const botMock = createBotMock() as unknown as ExplainController
    el.bot = botMock
    document.body.appendChild(el)
    await flushPromises()
    expect(typeof el.start).toBe('function')
    expect(typeof el.open).toBe('function')
    // expose 补挂不得污染声明 props.bot（accessor setter 陷阱），注入的 mock 保持原样
    const instance = (el as unknown as { _instance?: { props?: { bot?: unknown } } })._instance
    expect(instance?.props?.bot).toBe(botMock)
    el.remove()
  })
})
