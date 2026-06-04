# GPT2 UI Demo - 工作进度与交接文档

## 当前版本: v5 — gpt2-ui-demo-v5.html

## v5 改动
1. **drawer-header 移到 drawer 顶端** — 展开时 header 在上方，body 向下展开；点击 header/body 折叠，逻辑正确
2. **去除所有动画** — 无 transition/transform 动画，display:none/block 即时切换
3. **控件复用** — 提取 `.btn-outline` `.btn-text` `.btn-primary` `.btn-secondary` `.select-ctl` `.input-ctl` `.icon-btn` 7个共享控件类
4. **精简代码** — 去除冗余 hover/opacity/shadow、CSS变量压缩、JS压缩

## 竖屏抽屉逻辑（v5）
- `#historyDrawer`: fixed bottom, flex-column
- `.drawer-header`: 在 DOM 中排在 drawer-body 前面 → 视觉上在顶端
- 收起时: drawer-body `display:none`，只看到底部的 header 条
- 展开时: drawer-body `display:block`，header 在上方，body 向下展开
- 箭头: 收起▲(向上拉) / 展开▼(向下合)

## 等 styleguide.html 上传后对齐控件样式

## 文件位置
- GitHub: https://github.com/lishuhang/photos/tree/main/gpt2-ui/
- 当前: gpt2-ui-demo-v5.html
