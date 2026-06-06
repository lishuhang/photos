# Global Wire v2.2 开发进度追踪

## 历史背景（来自上一个任务记录摘要）

### v1.0 → v1.1
- 添加RSS源更新功能，显示更新banner，桌面通知，设置页README/changelog
- 版本号从1.0升级到1.1，部署到GitHub Pages和Cloudflare Workers

### v1.1 → v1.2
- 去除不必要动效，提升加载速度
- RSS竞速（ping源，最快先显示）
- 移除Babel(~800KB)→htm(~1KB)，Lucide(~100KB)→内联SVG
- 并发获取，渐进式渲染

### v1.2 → v1.3
- 修复浅色模式切换导致页面消失
- 修复设置入口丢失
- 三态主题：浅色/深色/跟随系统
- 修复htm不支持HTML注释和Fragment简写导致的白屏

### v1.3 → v2.0
- 蓝色更新banner从页面顶部移到header下方时间线区域居中toast
- 修复浏览器通知（增加click-to-focus）
- 设置图标改回齿轮
- 新增AI翻译和摘要功能（GLM-4-flash/Gemini-2.0-flash）
- i18n支持（简体中文/English/繁体中文）
- 版本号升级到v2.0

### v2.0 → v2.1
- AI助手设置面板（语言/自动翻译/摘要/存储上限）
- 主界面标题栏摘要复选框
- 自动翻译开关（替换原标题/显示原文）
- 翻译/摘要失败重试
- 更新API Key后自动重试失败条目
- 本地存储条目上限（100/500/1000/全部）

### 技术约束
- 单HTML文件，React 18 + htm（不用Babel）
- **htm限制**：不支持HTML注释 `<!-- -->`，不支持Fragment简写 `<>`，否则会InvalidCharacterError崩溃白屏
- 部署：GitHub push + Cloudflare Worker API更新

---

## v2.2 当前开发进度

### 用户需求（4项修复 + 版本号更新）
1. **Toast动画修复**：更新新闻源toast会在页面停留，刷出新内容时从时间轴顶端向下漂移淡出
2. **自动翻译修复**：勾选自动翻译后，新刷出的内容应第一时间翻译标题（之前有缓存错误条目不会重试的问题）
3. **UI简化**：移除"摘"小按钮（摘要由开关统一控制）；自动翻译时不附带原文标题，关闭翻译时直接显示原文
4. **摘要逻辑重写**：摘要不应把标题当原文发给AI，应先抓取文章原文，用turndown转为markdown，再交AI总结
5. **版本号升级**：v2.1 → v2.2

### 开发日志

#### Step 1: 读取v2.1源码
- 读取了 `/home/z/my-project/download/index.html`（1934行，v2.1）
- 分析了4个需要修复的问题

#### Step 2: 添加turndown.js CDN
- 在head中添加 `<script src="https://unpkg.com/turndown/dist/turndown.js"></script>`
- 版本号从v2.1更新为v2.2

#### Step 3: Toast动画优化
- 添加CSS动画 `toast-drift-down`（从原位向下漂移60px并淡出，1.2s）
- 添加CSS动画 `toast-fade-in`（从上方淡入，0.3s）
- UpdateBanner组件：
  - updating状态：使用toast-fade-in动画
  - available/updated状态：使用toast-drift-out动画（漂移淡出）
  - 移除了sticky定位，改为相对定位

#### Step 4: 修复自动翻译
- 原bug：useEffect中只检查 `!existing`，导致localStorage中缓存了错误条目（`__ERROR__:...`）时不会重试
- 修复：改为 `!existing || existing.startsWith(AI_ERROR_PREFIX)`，同时传递 `!!existing` 作为isRetry参数，确保错误条目也会被重试

#### Step 5: 移除"摘"按钮和原文附带显示
- NewsCard组件：移除onSummary prop，移除"摘"按钮（之前在 `!showSummary` 时显示）
- 移除自动翻译时原文标题的显示（之前会以小字斜体显示原文）
- 现在逻辑：autoTranslate=true → 只显示翻译标题；autoTranslate=false → 只显示原文+翻译按钮+翻译结果

#### Step 6: 重写摘要逻辑（核心修复）
- 原问题：摘要只发标题给AI，导致AI只能复述标题
- 新方案：
  1. 使用Turndown.js将抓取到的HTML转为Markdown
  2. 移除噪音元素（script/style/nav/footer/header/iframe/ad/sidebar/comments等）
  3. 智能定位正文：优先找article/[role="article"]/.article-content/.post-content/.entry-content/.content/body
  4. Markdown截取上限4000字符（比之前3000字符的纯文本更有信息量）
  5. 如果无法获取正文（< 200字符），不生成摘要而是标记错误
  6. 不再回退到只用标题的模式

#### Step 7: 更新README和Changelog
- 三语言README更新：产品用途段落更新为v2.2说明
- 三语言Changelog更新：添加v2.2条目
- 三语言AI Agent调试笔记更新：v2.2架构说明

#### Step 8: 部署（进行中）
- 需要GitHub token和Cloudflare API token
