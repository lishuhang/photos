# GPT2 UI Demo - 工作进度与交接文档

## 当前版本: v5 — gpt2-ui-demo-v5.html

## v5 改动（本次全部完成）
1. **drawer-header 在 drawer 顶端** — 展开时 header 在上方向下展开 body，收起时向上合上，逻辑正确
2. **去除所有动画** — 无 transition/animation，display:none/block 即时切换
3. **对齐 styleguide 控件** — 使用 `.btn` `.btn-primary` `.btn-outline` `.btn-ghost` `.btn-sm` `.btn-full` `.select-field` `.input-field` `.checkbox-wrap` `.icon-btn` 等 styleguide 标准类
4. **CSS 变量对齐** — 使用 styleguide 的 --accent --text --border --radius-sm --space-* --font-* 等变量体系
5. **精简冗余** — 去除旧的自定义类(.btn-text .btn-secondary等)，统一到 styleguide 命名；SVG stroke 硬编码色改为 currentColor
6. **无冗余代码** — 仅引入本项目用到的 styleguide 部分，未搬运未使用组件

## 从 styleguide 引入的控件映射

| 页面元素 | styleguide 类 |
|---------|---------------|
| 粘贴/清空/提示词库 | .btn .btn-ghost .btn-sm |
| 下拉菜单 | .select-field |
| 提示词输入框 | .input-field |
| 生成按钮 | .btn .btn-primary .btn-full |
| 添加水印/去除SynthID | .btn .btn-outline |
| 进行中 checkbox | .checkbox-wrap |
| 导出按钮 | .btn .btn-outline .btn-sm |
| 清空按钮 | .btn .btn-danger-outline .btn-sm |
| 复制/下载图标 | .icon-btn |

## 竖屏抽屉逻辑
- drawer-header 在 DOM 中排在 drawer-body 前面 → 固定 bottom 时 header 在顶端
- 收起: drawer-body display:none，只看到底部的 header 条
- 展开: drawer-body display:block，header 在上方，body 向下展开
- 箭头: 收起▲ / 展开▼

## 文件位置
- GitHub: https://github.com/lishuhang/photos/tree/main/gpt2-ui/
- 当前: gpt2-ui-demo-v5.html
