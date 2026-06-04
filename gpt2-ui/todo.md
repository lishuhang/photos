# GPT2 UI Demo - 工作进度与交接文档

## 项目概述

根据用户提供的 Cloudflare Workers 页面设计效果图，重建一个纯 UI 的单页面 HTML 文件。**只做 UI 不做功能**，最终输出为包含完整内联 CSS 的单 HTML 文件。

---

## 需求要点

1. **严格遵循效果图**，不要被原始源代码描述迷惑（已纠正多次）
2. 单页面 HTML + 完整内联 CSS，无外部依赖
3. 字号比效果图略大
4. 所有图标手绘 SVG，不依赖外部图标库
5. **横屏两栏布局**：左侧提示词表单 + 中间任务列表（centerPanel）
6. **历史记录（任务列表）在竖屏时变为底部抽屉**，横屏无抽屉
7. 竖屏时左侧全宽，抽屉从底部飞出包含 taskCard
8. 参考图区域：右侧添加按钮固定，其余水平滚动；2个 60x60 base64 示例图片
9. 所有按钮为假按钮（`onclick="return false"`），文本/状态参考原始 JS
10. 保留原始 div ID，便于后续 Worker 代码集成
11. 最快加载、最小 CSS 体积
12. **面板无圆角矩形外框和阴影**

---

## 版本历史

### v1（首轮）
- 根据源代码构建初始页面
- **问题**：过度跟随源代码，未严格遵循效果图
  - 宽高比做了14个按钮组（应为下拉菜单）
  - "提示词"三个字作为标签（应为 placeholder）
  - 粘贴按钮位置不对

### v2 — gpt2-ui-demo-v2.html
- 布局修正为两栏：`#leftPanel`(380px) + `#centerPanel`
- 移除了 `#rightPanel`
- 下拉菜单 2×2 网格无标签
- 历史记录为右侧滑出抽屉
- **遗留问题**：card 仍有圆角+阴影；抽屉横屏也存在；taskCard 没有根据屏幕方向重定位

### v3（当前版本）— gpt2-ui-demo-v3.html
核心改动：
1. **去除 card 圆角和阴影**：`.card{background:var(--bg);padding:var(--gap)}` — 无 border/border-radius/box-shadow
2. **taskCard 横屏在 centerPanel，竖屏移入 historyDrawer**：JS `relocateTaskCard()` 在 resize 时移动 DOM 节点
3. **historyDrawer 仅竖屏存在，从底部飞出**：
   - 横屏：`#historyDrawer{display:none}` + `#drawerToggle{display:none}`
   - 竖屏：drawer `position:fixed;bottom:0;` + `transform:translateY(100%)` → `.open{translateY(0)}`
   - toggle 按钮变为右下角紫色圆形 FAB
   - 抽屉高度 65vh，顶部圆角 12px

---

## 当前 HTML 结构

```
<body>
  <nav id="topNav">                    ← 顶部导航
  <div id="mainWrap">                  ← 横屏: flex-row / 竖屏: flex-column
    <div id="leftPanel">               ← 左栏：提示词表单
      <div id="promptCard">
        <textarea id="promptArea">
        <div class="prompt-actions">   ← 粘贴/清空/提示词库
        <div class="dropdown-grid">    ← 4个select 2×2
        <div class="ref-upload">       ← 参考图
        <button id="generateBtn">      ← 生成图片 2点
        <div class="extra-btns">       ← 添加水印/去除SynthID
    <div id="centerPanel">             ← 横屏：包含 taskCard
      <div id="taskCard">              ← ⚠️ JS会在竖屏时移到 drawerBody
  <div id="historyDrawer">             ← 竖屏底部抽屉（横屏display:none）
    <div class="drawer-header">        ← 历史记录 + 收起按钮
    <div class="drawer-body" id="drawerBody">  ← 竖屏时容纳 taskCard
  <button id="drawerToggle">           ← 竖屏右下角FAB（横屏display:none）
```

### 关键 JS 行为

- `relocateTaskCard()`: 检测 `window.innerWidth<=768`，将 `#taskCard` 在 `#centerPanel` 和 `#drawerBody` 之间移动
- `toggleDrawer()`: 切换 `#historyDrawer.open` 类
- 窗口 resize 时自动触发 `relocateTaskCard()`

---

## 仍需验证/可能需要调整的问题

1. **竖屏下拉菜单对齐**：用 `grid-template-columns: 1fr 1fr` 修复，需实际竖屏测试
2. **参考图占位图**：当前用 JS canvas 生成，可能需要替换为真实 base64 图片
3. **抽屉高度**：当前 65vh（极窄 75vh），可能需要调整
4. **字号**：用户要求比效果图略大，当前值可能还需调整
5. **taskCard DOM移动**：resize时移动DOM节点，如果有后续JS绑定事件需注意

---

## 关键颜色参考

| 用途 | 色值 |
|------|------|
| 页面背景 | #FFFFFF |
| 导航栏背景 | #F5F5F5 |
| 边框 | #E0E0E0 |
| 深蓝色（按钮文字/点数） | #3333CC |
| 紫色（生成按钮/FAB） | #6A5ACD |
| 成功状态 | #00CC00 |
| 失败状态 | #FF0000 |
| 超时状态 | #FFCC00 |
| 深灰色（图标） | #666666 |
| 浅灰色（时间/placeholder） | #999999 |

---

## 用户历史反馈摘要

1. **"请更严格地遵循图片描述而不是源代码描述"** → 下拉菜单替代按钮组
2. **"下拉菜单上面没有小文字标签"** → 移除 select 上方 label
3. **"竖屏下拉菜单全右对齐"** → CSS grid 修复
4. **"宽屏是两栏不是三栏"** → 移除 rightPanel
5. **"历史记录是抽屉不是栏"** → 抽屉实现
6. **"竖屏历史记录是浮动抽屉"** → 抽屉所有尺寸浮动
7. **"圆角矩形外框和阴影不必要"** → 去除 .card 的 border/border-radius/box-shadow
8. **"taskCard横屏在centerPanel，竖屏在historyDrawer"** → JS relocateTaskCard()
9. **"historyDrawer只在竖屏有，从底部飞出"** → 横屏display:none，竖屏bottom滑入

---

## 文件位置

- GitHub: `https://github.com/lishuhang/photos/tree/main/gpt2-ui/`
- 当前版本: `gpt2-ui-demo-v3.html`
