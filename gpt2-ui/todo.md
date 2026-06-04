# GPT2 UI Demo - 工作进度与交接文档

## 项目概述

根据用户提供的 Cloudflare Workers 页面设计效果图，重建一个纯 UI 的单页面 HTML 文件。**只做 UI 不做功能**，最终输出为包含完整内联 CSS 的单 HTML 文件。

---

## 需求要点

1. **严格遵循效果图**，不要被原始源代码描述迷惑（已纠正多次）
2. 单页面 HTML + 完整内联 CSS，无外部依赖
3. 字号比效果图略大
4. 所有图标手绘 SVG，不依赖外部图标库
5. **横屏两栏布局**：左侧提示词表单 + 中间任务列表
6. **历史记录是右侧滑出抽屉**，不是独立栏
7. 竖屏时左侧+中间上下堆叠，历史记录仍为浮动抽屉
8. 参考图区域：右侧添加按钮固定，其余水平滚动；2个 60x60 base64 示例图片
9. 所有按钮为假按钮（`onclick="return false"`），文本/状态参考原始 JS
10. 保留原始 div ID，便于后续 Worker 代码集成
11. 最快加载、最小 CSS 体积

---

## 已完成的工作

### v1（首轮）
- 根据源代码构建初始页面
- **问题**：过度跟随源代码，未严格遵循效果图
  - 宽高比做了14个按钮组（应为下拉菜单）
  - "提示词"三个字作为标签（应为 placeholder）
  - 粘贴按钮位置不对

### v2（当前版本）— gpt2-ui-demo-v2.html
- **布局修正为两栏**：`#leftPanel`(380px) + `#centerPanel`(弹性宽度)
- 移除了 `#rightPanel`（之前错误地做成三栏）
- **下拉菜单**：4个 select 排 2×2 网格，**无上方文字标签**
  - GPT-Image-2 / 1张 / 1.5K 标准 / 1:1
- **提示词输入框**：无 label，placeholder 为"提示词"
- 输入框下方按钮：粘贴 / 清空 / 提示词库
- **参考图区域**：有图片时显示水平滚动行 + 固定添加按钮；无图片时显示虚线上传框
- **生成按钮**：紫色(#6A5ACD) "生成图片 2点"
- **附加按钮**：添加水印 / 去除SynthID
- **历史记录抽屉**：
  - 右侧边缘固定 toggle 按钮（收起↑/展开↓）
  - 抽屉从右侧滑出(340px宽)
  - 包含：历史记录标题 + 收起按钮 + 进行中checkbox + 导出/清空 + 历史任务列表
- **任务列表**：3个示例任务（成功绿勾/失败红叉/超时黄叹号）
- **竖屏响应式**：
  - leftPanel + centerPanel 上下堆叠
  - 下拉菜单 2×2（极窄屏 1×1）
  - 历史抽屉宽度 85vw/92vw

---

## 仍需验证/可能需要调整的问题

1. **竖屏下拉菜单对齐**：之前反馈竖屏时 dropdown 全部右对齐，当前用 `grid-template-columns: 1fr 1fr` 修复，需实际竖屏测试验证
2. **参考图区域**：当前用 JS canvas 生成占位图，可能需要替换为真实 base64 图片
3. **抽屉在竖屏的交互**：toggle 按钮位置和抽屉宽度可能需要微调
4. **字号**：用户要求比效果图略大，当前值可能还需调整
5. **细节配色/间距**：虽然按用户给的详细色号实现，但视觉效果可能与效果图有差异

---

## 关键颜色参考

| 用途 | 色值 |
|------|------|
| 页面背景 | #FFFFFF |
| 导航栏背景 | #F5F5F5 |
| 边框 | #E0E0E0 |
| 深蓝色（按钮文字/点数） | #3333CC |
| 紫色（生成按钮） | #6A5ACD |
| 成功状态 | #00CC00 |
| 失败状态 | #FF0000 |
| 超时状态 | #FFCC00 |
| 深灰色（图标） | #666666 |
| 浅灰色（时间/placeholder） | #999999 |

---

## HTML 结构（v2）

```
<body>
  <nav id="topNav">              ← 顶部导航：AI生图 + 剩余点数 + 设置图标
  <div id="mainWrap">            ← 横屏flex两栏 / 竖屏flex-column
    <div id="leftPanel">         ← 左栏：提示词表单
      <div class="card" id="promptCard">
        <textarea id="promptArea">
        <div class="prompt-actions">  ← 粘贴/清空/提示词库
        <div class="dropdown-grid">   ← 4个select 2×2
        <div class="ref-upload">      ← 参考图上传区（虚线框/滚动行）
        <button id="generateBtn">     ← 生成图片 2点
        <div class="extra-btns">      ← 添加水印/去除SynthID
    <div id="centerPanel">       ← 中间栏：任务列表
      <div class="card" id="taskCard">
        <div class="task-header">     ← 进行中checkbox + 导出/清空
        <div class="task-list">       ← 任务项列表
  <div id="historyDrawer">       ← 右侧滑出抽屉（fixed定位）
  <button id="drawerToggle">     ← 抽屉开关按钮（fixed右侧边缘）
```

---

## 用户历史反馈摘要

1. **"请更严格地遵循图片描述而不是源代码描述"** → 下拉菜单替代按钮组，提示词用 placeholder
2. **"下拉菜单上面没有小文字标签"** → 移除所有 select 上方的 label
3. **"竖屏下拉菜单全右对齐"** → 用 CSS grid 修复
4. **"宽屏是两栏不是三栏"** → 移除 rightPanel，改为 centerPanel
5. **"历史记录是抽屉不是栏"** → 历史记录用 fixed 定位滑出抽屉实现
6. **"竖屏历史记录不是按钮而是浮动抽屉"** → 抽屉在所有屏幕尺寸都是浮动层

---

## 文件位置

- GitHub: `https://github.com/lishuhang/photos/tree/main/gpt2-ui/`
- 当前版本: `gpt2-ui-demo-v2.html`
