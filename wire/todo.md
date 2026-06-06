# Global Wire v2.1 开发进度追踪

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

### 技术约束
- 单HTML文件，React 18 + htm（不用Babel）
- **htm限制**：不支持HTML注释 `<!-- -->`，不支持Fragment简写 `<>`，否则会InvalidCharacterError崩溃白屏
- 部署：GitHub push + Cloudflare Worker API更新

---

## v2.1 当前开发进度

### 用户需求
1. **设置-AI助手tab**：界面及AI助手语言下拉；自动翻译复选框；本地存储保存量下拉（100/500/1000/全部，默认100）
2. **主界面标题条v2.1右侧**：摘要复选框
3. **自动翻译**：选中时隐藏单个条目翻译按钮，自动替换原标题，刷新一个翻译一个
4. **自动摘要**：选中时在条目下显示摘要文本，刷新一个摘要一个
5. **失败重试**：标题后附重试小链接，摘要区附重试小链接
6. **智能重试**：设置中更新API key后关闭设置，自动重试所有失败条目（不重复已成功的）
7. **todo.md**：摘要初始prompt，忠实记录每步做法，每次做完更新并同步到GitHub

### 开发日志

#### Step 1: 读取源文件和Chrome插件参考
- 读取了 `/home/z/my-project/download/index.html`（2026行，v2.0）
- 解压并读取了 `chrome_140word.zip`（sidebar.js, background.js, manifest.json）
- Chrome插件关键参考：
  - DEFAULT_PROMPT：简化文章为200字以内一句话总结，保留关键数字，输出中文
  - 支持zhipu/gemini/deepseek模型
  - 文章内容提取：DOMParser解析HTML，提取main/article/body文本，截取12000字
  - 队列式处理，避免并发API调用

#### Step 2: 创建todo.md

#### Step 3: 编写v2.1完整代码
- 版本号升级为v2.1
- 新增设置-AI助手tab（4个标签页：新闻源/通用/AI助手/说明）
- AI助手tab包含：界面及AI助手语言下拉、自动翻译复选框、AI模型选择、API Key输入、API端点、本地存储条目上限（100/500/1000/全部，默认100）
- 主界面Header中v2.1标签旁新增摘要复选框
- NewsCard组件重构：
  - autoTranslate=true时隐藏"译"按钮，显示翻译后的标题，原文显示为小字斜体
  - autoTranslate=false时显示"译"按钮和翻译结果
  - showSummary=true时隐藏"摘"按钮，自动显示摘要
  - showSummary=false时显示"摘"按钮，点击展开摘要
  - 翻译失败：标题后附"重试翻译"小链接
  - 摘要失败：摘要区附"重试摘要"小链接
- AI缓存持久化到localStorage（ai_translations_v1, ai_summaries_v1）
  - 格式：{id: {text: string, ts: number}}
  - 错误以__ERROR__前缀标记
  - 保存时按时间戳排序，超出limit时截断
- AI处理队列：避免并行API调用，按顺序处理
- 关闭设置时检测API Key变更，自动重试所有失败条目
- 新增i18n字符串：auto_translate, show_summary_label, cache_limit, retry_translate, retry_summary等
- 新增localStorage keys: ai_auto_translate, ai_show_summary, ai_cache_limit, ai_translations_v1, ai_summaries_v1
- README/Changelog更新为v2.1

#### Step 4: 浏览器自测
- 使用agent-browser测试
- 页面正常渲染，无JS错误
- 设置弹窗4个标签页正常显示
- 摘要复选框在Header中正确显示
- API Key配置后，翻译功能正常：测试GLM-4-flash，"Japan's corporate real estate sales hit 18-year high on strong demand"翻译为"日本企业房地产销售需求强劲创18年新高"
- 摘要功能正常：生成"日本企业地产销售18年最高，需求强劲"
- 自动翻译：开启后，英文标题自动替换为中文翻译
- 自动摘要：开启后，条目下方自动显示摘要
- 无控制台错误

#### Step 5: 部署到GitHub和Cloudflare Worker（进行中）
