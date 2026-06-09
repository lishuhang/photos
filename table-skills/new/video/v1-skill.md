---
name: article-to-video
description: 将文章/报告/分析文档自动转化为竖版短视频（HTML动画 → MP4）。当用户提到"做视频"、"视频化"、"文章转视频"、"短视频制作"、"竖屏视频"、"HTML录屏"等场景时触发。适用于行业分析文章、数据报告、趋势解读等图文内容的一键视频化生产。即使用户只说"帮我做个视频"而上下文有文档或文章素材，也应触发此skill。
---

# Article-to-Video：文章转竖版短视频

将分析类文章/报告转化为 9:16 竖版解说视频，整个流程从文本分析到最终 MP4 输出全自动化。

## 核心理念

视频的本质是**视听同步**——画面节奏严格跟随旁白台词，每一个画面元素都有出入动效，文字信息精简到一屏 <50 字，复杂内容拆细到每个要点独立成帧。视频不是 PPT 放映，而是以时间轴为核心的叙事。

## 技术栈

| 环节 | 工具 | 说明 |
|------|------|------|
| 语音合成 | tts.lishuhang.com (nicevoice) | 音源"乐乐"，可保存为"乐乐" |
| AI生图 | gpt2.lishuhang.com | 多账号轮流，导入 JSON 账号文件 |
| 图表动画 | lishuhang/photos (skill06) | 纯 CSS/JS 图表，直接合并到大 HTML |
| HTML→视频 | Playwright + Chromium | screen capture 录制 |
| 视频编码 | ffmpeg | webm → mp4，合并音轨 |

## 画幅规范

- **画布**：450 x 800px（9:16 竖版）
- **内容区**：居中 1:1（450x450），图表和图文内容限制在此区域
- **字幕区**：1:1 框之下、3:4 框之内（约 y:560-700），白色阿里巴巴普惠体 + 黑色描边
- **背景**：#0a0e27 深色主题

## 字体

阿里巴巴普惠体（AlibabaPuHuiTi），5 个字重：
```
Thin(100) / Regular(400) / Medium(500) / Bold(700) / Black(900)
```
CSS 引用路径：`assets/AlibabaPuHuiTi-3-{weight}.woff`

## 完整生产流程

### 第一步：输入与分析

**输入**：原文 Word + 脚本 Word（如无脚本则从原文生成）

1. **提取所有专有名词**：公司名、人名、作品名、技术术语
   - 公司名 → 需要真实 Logo
   - 作品名 → 需要真实海报/剧照/预告片
   - 技术术语 → 需要对应示意图或 AI 生成图
2. **提取所有数字**：百分比、排名、薪资、人数等
3. **提取所有图表**：
   - 原文中已有的表格/图表必须 1:1 还原
   - 包含图片的需 OCR 提取文字
   - 文字较多的图表拆分为多帧

### 第二步：素材获取

**严格规则**：
- **Logo / 海报 / 剧照**：必须从网上搜索真实图片，禁止 AI 生成
  - 搜索途径：百度图片、微博、豆瓣、官方公众号
  - 华策、博纳等上市公司 Logo 从官网获取
  - 剧集海报从豆瓣/微博获取
- **视频素材**：优先找真实预告片/片段
  - 来源：B站、微博、YouTube
  - 使用 ffmpeg 均匀截图做故事板，决定是否使用
  - 裁剪到所需秒数，丢弃剩余
  - 嵌入 HTML 的 `<video>` 标签，作为画布底层播放
- **AI 生图**：仅用于没有真实图片的概念性内容
  - 使用 gpt2.lishuhang.com
  - 多账号轮流（导入 `ai_image_generator_accounts_*.json`）
  - 上传到 GitHub repo `lishuhang/photos` 供 HTML 引用

### 第三步：分镜表制作

生成 `shots.md` 分镜表，格式：

```markdown
| # | 时间 | 时长 | 类型 | 画面内容 | 字幕台词 | 素材 |
|---|------|------|------|----------|----------|------|
| 01 | 0.0 | 2.8 | 标题 | 主标题动效 | 传统影视公司做漫剧 | title_bg.png |
```

**分镜规则**：
1. 一帧图文 <50 字，超出则拆分
2. 每个画面定格 2-3 秒（或严格对应 SRT 时长）
3. 所有元素必须有入场动效 + 退出动效（淡入淡出）
4. 说到公司名 → 出 Logo
5. 说到作品名 → 出海报/画面
6. 背景用图片铺满，淡出到半透明底，上叠 Logo/文字
7. 文字、数字等标签尽量居中显示

### 第四步：根据素材调整分镜

下载完所有素材后：
1. 检查每个分镜的素材是否到位
2. 无法获取的素材 → 用 AI 生图替代（非 Logo/海报类）
3. 有视频素材的 → 调整分镜时长，嵌入视频播放
4. 重新对齐时间轴和 SRT 字幕

### 第五步：HTML 拼装

**单 HTML 文件**，所有内容内联：
- 字体 CSS（5 个 @font-face）
- 全部场景的 HTML 结构
- 图表动画直接合并（参照 skill06 的 CSS/JS 动画）
- SRT 字幕数据内联为 JS 数组
- 音频文件 `<audio>` 标签
- JavaScript 时间轴控制器

**关键架构**：

```html
<div class="canvas" id="canvas">
  <div id="subtitle"></div>
  <!-- 场景1 -->
  <div class="scene" id="s01" data-start="0.0" data-dur="2.8">
    <!-- 内容元素，每个都有 data-anim 和 data-delay -->
  </div>
  <!-- 场景2... -->
  <audio id="audio" src="assets/audio.wav" preload="auto"></audio>
</div>
```

**动画系统**：
- 每个元素用 `data-anim` 指定动画类型，`data-delay` 指定延迟
- 动画类型映射：`fadeIn`, `slideUp`, `slideLeft`, `slideRight`, `popIn`, `flashIn`, `zoomIn`
- 初始状态 `opacity:0`，由 JS 在场景激活时触发
- 图表动画保持 skill06 原有 CSS @keyframes（barGrow, radarFadeIn, bubblePop 等）

**视频嵌入**：
```html
<video class="vid-bg" src="assets/videos/xxx.mp4" muted playsinline preload="auto"></video>
<div class="vid-overlay"></div>
```
视频作为画布底层（z-index:0），叠加半透明遮罩和上层内容。

**字幕**：
- 内嵌 HTML，不烧录
- 位置：bottom 区域，1:1 框外、3:4 框内
- 样式：白色阿里巴巴普惠体，黑色 text-shadow 描边
- 根据 SRT 时间戳自动显示/隐藏

### 第六步：录制与编码

1. **Playwright 录制**：
   ```bash
   # 启动 headless Chromium，打开 HTML
   # 页面自动播放：点击 canvas 触发 audio.play()
   # screen capture 录制为 webm
   ```
2. **ffmpeg 编码**：
   ```bash
   # webm → mp4
   ffmpeg -i recording.webm -c:v libx264 -pix_fmt yuv420p video_only.mp4
   # 合并音轨
   ffmpeg -i video_only.mp4 -i audio.wav -c:v copy -c:a aac -shortest final.mp4
   ```

## 图表制作规范

参照 GitHub repo `lishuhang/photos` 的 skill06 方法：
- 所有图表用纯 CSS/JS 动画（@keyframes, CSS custom properties, conic-gradient, clip-path, stroke-dasharray）
- 直接合并到大 HTML 中，不生成独立文件
- 图表内容区域限制在 1:1 范围内（450x450 居中）
- 入场动画序列化：标题先入 → 数据逐步展示 → 数值最后显现

### 图表类型速查

| 类型 | 核心动画 | 示例 |
|------|----------|------|
| 横向条形图 | `barGrow` scaleX(0→1) | Table1: AI岗位占比 |
| 卡片分类 | `slideUp` + `popIn` tag | Table2: 招聘动机 |
| 分组柱状图 | `barGrowUp` scaleY(0→1) | Table3: 路径对比 |
| 雷达图 | `radarFadeIn` scale(0.3→1) | Table4: 应用方向 |
| 气泡图 | `bubblePop` scale(0→1.1→1) | Table5: 投入程度 |
| 轮播卡片 | translateX(60px→0) | Table6: 核心洞察 |

## 语音与字幕

### 语音合成
- 平台：tts.lishuhang.com
- 引擎：nicevoice
- 音源：乐乐15s（保存为"乐乐"）
- 导出格式：WAV

### 字幕
- SRT 格式
- 嵌入 HTML 时转为 JS 数组：`[{s:0, e:1.5, t:"台词"}, ...]`
- 样式：`font-size:18px; font-weight:500; color:#fff; text-shadow: 2px 2px 4px rgba(0,0,0,0.9), -1px -1px 2px rgba(0,0,0,0.9)...`
- 不换行：确保字幕文本足够短，不会超出屏幕宽度

## 质量检查清单

- [ ] 每个场景的图表动画已整合（非静态截图）
- [ ] 所有 Logo/海报为真实网络图片（非 AI 生成）
- [ ] 一屏文字 <50 字，超出已拆分
- [ ] 所有元素有出入动效
- [ ] 每帧定格 ≥2 秒（或严格匹配 SRT）
- [ ] 字幕与台词严格对应
- [ ] 视频素材已裁剪、嵌入底层播放
- [ ] 背景图铺满 + 半透明淡出
- [ ] 文字/数字居中显示
