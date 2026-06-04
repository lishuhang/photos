# GPT2 UI Demo - 工作进度与交接文档

## 项目概述

根据用户提供的 Cloudflare Workers 页面设计效果图，重建纯 UI 单页面 HTML。**只做 UI 不做功能**。

---

## 需求要点

1. 严格遵循效果图，不被源代码迷惑
2. 单页面 HTML + 完整内联 CSS，无外部依赖
3. 字号比效果图略大
4. 所有图标手绘 SVG
5. **横屏两栏**：左侧提示词表单 + 中间任务列表（centerPanel）
6. **竖屏**：左侧全宽 + 底部抽屉（drawer-header 常驻底部，点击展开 drawer-body）
7. 面板无圆角外框无阴影
8. 下拉菜单无标签，2×2 网格
9. 所有按钮 `onclick="return false"`
10. 保留原始 div ID

---

## 版本历史

### v1 — 首轮
- 过度跟随源代码，未严格遵循效果图

### v2 — gpt2-ui-demo-v2.html
- 两栏布局 `#leftPanel` + `#centerPanel`
- 去掉 rightPanel
- 历史记录右侧滑出抽屉
- 遗留：card 有圆角阴影；抽屉横屏也存在

### v3 — gpt2-ui-demo-v3.html
- 去除 card 圆角和阴影
- taskCard 横屏 centerPanel / 竖屏移入 drawer
- historyDrawer 仅竖屏，从底部飞出
- 使用 FAB 按钮切换

### v4（当前）— gpt2-ui-demo-v4.html
核心改动：
1. **extra-btns**：竖屏不再竖排，保持和横屏一样的水平布局（浏览器>=380px都够放两个按钮）
2. **ref-add-btn**：改为 60×60 与缩略图同大小
3. **去除 #drawerToggle FAB**：改为 `.drawer-header` 竖屏常驻底部，内部 button 负责展开/收起
4. **精简代码**：去除冗余 `.card` 包裹、叠床架屋的注释和过时 CSS

### 竖屏抽屉交互（v4）
- `#historyDrawer`：fixed bottom，竖屏才 display:flex
- `.drawer-header`：常驻底部，灰色背景，显示"历史记录"标题 + 箭头按钮
- `.drawer-body`：max-height:0 隐藏，`.open` 时 max-height:65vh 展开
- 点击 header 或 header 内的 button 都可切换展开/收起
- 箭头方向通过 JS 动态修改 SVG polyline points

---

## 当前 HTML 结构

```
<body>
  <nav id="topNav">
  <div id="mainWrap">
    <div id="leftPanel">       ← textarea + actions + dropdowns + ref + generate + extra-btns
    <div id="centerPanel">     ← 横屏时容纳 #taskCard
  <div id="historyDrawer">     ← 竖屏底部抽屉（横屏 display:none）
    <div class="drawer-body">  ← 展开时容纳 #taskCard
    <div class="drawer-header">← 常驻底部，点击切换展开
```

---

## 关键颜色

| 用途 | 色值 |
|------|------|
| 深蓝色 | #3333CC |
| 紫色（生成/FAB） | #6A5ACD |
| 成功 | #00CC00 |
| 失败 | #FF0000 |
| 超时 | #FFCC00 |

---

## 文件位置

- GitHub: `https://github.com/lishuhang/photos/tree/main/gpt2-ui/`
- 当前版本: `gpt2-ui-demo-v4.html`
