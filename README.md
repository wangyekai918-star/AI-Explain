# AI讲解

AI 讲解 H5 组件：IP 形象入口、迷你播放器、展开聊天面板、连续回答进度和点击式语音交互。

**[在线预览](https://wangyekai918-star.github.io/AI-Explain/)** · [产品说明](product-guide.md) · [交付与验收](delivery-guide.md) · [开发交接](development-handoff.md)

预览使用模拟数据和浏览器朗读，不连接真实 AI、后端 TTS 或 ASR。点击右下角 IP 形象开始；输入“请分三段回答”可体验连续回答进度。可切换深色模式，查看 IP 在深蓝背景上的表现。

## 本地运行

建议 Node.js 22.22.2+（22.x）或 24.15+（24.x），以匹配锁文件中传递依赖的引擎要求。

```sh
npm ci
npm run dev
```

访问终端输出的地址。首页与 `/demo/player.html` 为同一新版界面。

```sh
npm test
npm run build
npm run preview
```

## 仓库内容

| 目录或文件 | 内容 |
| --- | --- |
| `core/` | 会话状态机、讲解解析、播放、TTS、录音、事件流及测试 |
| `ui/` | Vue 组件、自定义元素、主题、IP 外壳与原生 SVG 眼睛/音柱、组件测试 |
| `demo/` | 模拟会话适配和演示页 |
| `index.ts` / `types.ts` | 对外出口与类型 |
| `scripts/build-pages.mjs` | 生成 GitHub Pages 静态目录 |
| `docs/` | 在线预览的已构建静态资源 |
| 根目录三个 `*-guide.md` / `development-handoff.md` | 完整产品、交付和开发规则 |

当前源码、运行素材、依赖锁文件、测试和发布脚本均已包含。未包含 node_modules、旧版备份、原始内部 PRD/接口资料或真实凭据。仓库地址采用 GitHub 支持的 `AI-Explain`，项目展示名称为“AI讲解”。

## 在线预览发布

```sh
npm ci
npm run build:pages
```

将源码改动及生成的 `docs/` 一起提交。GitHub Pages 设置使用 **Deploy from a branch → main → /docs**。`docs/` 是生成目录，不放手写产品文档；三份产品与交接文档放仓库根目录。构建使用相对资源路径，适配项目站点子路径。

## 当前交互基线

- IP：入口 70×70，标签45×19、居中贴底；无独立投影切图。
- 思考：圆眼等待转动；加载结束直接接五根圆角音柱，暂停/结束恢复椭圆眼，不插入成功表情。
- 迷你播放器：540px目标宽，全圆角、无描边，右侧操作34×34、间距8。
- 展开面板：外圆角32px、主讲解同类气泡间距6px、无正文时紧凑，变高变矮有动画。
- 一次回答的多段内容共用累计时间轴；暂停不断任务，定位和倍速作用于当前回答。
- 保存上次mini/expanded形态，关闭重开或刷新后恢复；不等于保存对话或音频进度。
- 深色Demo背景 #001027；播放按钮在思考禁用时显示loading。

## 验证与边界

2026-10-28 基线：13个测试文件、172项测试通过，Demo构建通过。新发布配置另以实际构建结果验证。浏览器朗读采用估算时长，精确音频定位需要真实音频metadata；真实后端、权限链路、ASR和真机兼容需单独联调。已知待办见[交付说明](delivery-guide.md#6-已确认差异与未关闭事项)。

## 来源与使用范围

眼部几何参考 Agent Robot Avatar，其 MIT 许可保留于 `ui/robot/LICENSE.txt`。这不自动授予品牌IP、切图或业务代码的同等许可；复用前确认各自授权范围。
