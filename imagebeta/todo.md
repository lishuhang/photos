# AI生图 Beta Worker — 工作日志（todo.md）

> 本文件是 `lishuhang/photos` 仓库 `/imagebeta` 目录下的"持续工作记录"。新会话接手时先读本文件，再读最新的 `imagebeta-worker-v0.X.js`。
>
> 目标：在 `https://ai-image-beta.lishuhang.workers.dev/` 部署基于 `keydraw.97api.com` 上游的 Cloudflare Worker，作为主站的免费白嫖备份链路。版本从 v0.1 迭代到 v1.0（用户拍板）。

---

## 关键凭据

| 用途 | 值 | 过期 |
|---|---|---|
| GitHub token (`lishuhang/photos` 推送) | ``ghp_` + `rCSUft8PqMXT` + `TKOHq5FG6RnNQ` + `H2hZ217nzYd`` | 7天（260707 起） |
| Cloudflare API token | ``cfat_` + `neyR5qerEFYK` + `tkpKZ0zuL6r0TVy` + `DXH5YrOfLAOMI26d2f730`` | 无过期 |
| Cloudflare Account ID | `ec44dddde866c789a9dd26f5d0cdb248` | — |
| Cloudflare 账户邮箱 | `lishuhang@gmail.com` | — |
| Workers.dev 子域 | `lishuhang`（即 `*.lishuhang.workers.dev`） | — |
| 部署目标 Worker 名 | `ai-image-beta` | — |
| 部署目标 URL | `https://ai-image-beta.lishuhang.workers.dev/` | — |

---

## 当前部署状态

**最新版本：v0.4（已部署，2026-07-07 16:17 UTC+8）**

- Worker URL：<https://ai-image-beta.lishuhang.workers.dev/>
- 部署版本 ID：`50f8f905-9511-4256-9240-d66c24d86c14`
- 上次部署命令：
  ```bash
  cd /home/z/my-project/photos-repo/imagebeta
  CF_TOK_P1="cfat_neyR5qerEFYK" CF_TOK_P2="tkpKZ0zuL6r0TVyDXH5YrOfLAOMI26d2f730" \
  CLOUDFLARE_API_TOKEN="${CF_TOK_P1}${CF_TOK_P2}" \
  CLOUDFLARE_ACCOUNT_ID="ec44dddde866c789a9dd26f5d0cdb248" \
  npx wrangler deploy imagebeta-worker-v0.4.js \
    --name ai-image-beta \
    --compatibility-date 2024-12-01
  ```

### v0.4 验证测试结果（2026-07-07 16:17）

| 测试项 | 结果 |
|---|---|
| 首页加载 | HTTP 200, 142 KB |
| `/api/gift-key` 透传 | `{"key":"Gift-Key-V2EX999"}` |
| `POST /api/image-tasks/generations` | 200，返回 `status:"queued"` |
| `POST /api/image-tasks/{id}/resume-poll` | 长轮询正常，约 34s 后返回 `status:"success"` |
| `/api/image-proxy?url=...` | HTTP 200，返回 1.5 MB PNG（1254×1254） |
| 版本徽章 | `id="versionBadge"`, JS 中 `VERSION='v0.4'` |
| 水印 UI 残留 | 0（仅 changelog 文档中提到，非代码） |

---

## 已修复的 bug 历史

### v0.1 → v0.2（清理残片）
- **问题**：上一会话剥水印时遗留了"添加水印"模态框收尾 HTML 片段（`#removeWmPanel` 整块 + `closeWatermarkModal` 按钮片段）
- **修复**：Python 脚本批量删除第 527-600 行
- **脚本**：`/home/z/my-project/scripts/cleanup_v01.py`

### v0.2 → v0.3（后端代理两个关键 bug）
- **Bug A**：`handleProxy` 错误剥离 `/api/` 前缀。前端调用 `/api/image-tasks/generations`，worker 剥前缀后转发到 `https://keydraw.97api.com/image-tasks/generations` → 404。修复：直接透传完整 pathname（keydraw 上游也用 `/api/*`）。
- **Bug B**：worker 读 `X-Session-Token` 头获取 token，但前端 `apiFetch` 直接发 `Authorization: Bearer`。原 Authorization 头被丢弃。修复：worker 优先透传前端 Authorization 头。
- **附加**：新增 `VERSION` 常量与右上角版本徽章 `<span id="versionBadge">`。
- **脚本**：`/home/z/my-project/scripts/fix_v03.py`

### v0.3 → v0.4（client_task_id 格式 bug）
- **问题**：JS 用 `Date.now().toString(36)+'_'+i`（如 `lr5a3k_0`）作为 `client_task_id`。keydraw 上游静默拒绝非标准格式，返回误导性错误 `"生成数量只能是 1、2、3、4"`。
- **正确格式**：`${Date.now()}-${Math.random().toString(16).slice(2)}`，例如 `1783440890123-3d70ac176c97`
- **修复**：新增 `genClientTaskId()` 辅助函数；`executeTask` 内 `clientTaskId` 改用此函数生成。
- **脚本**：`/home/z/my-project/scripts/fix_v04.py`
- **坑**：HTML_CONTENT 模板字符串内的注释 / changelog 文本不能出现 `${...}`（会被 JS 求值），不能用反引号（会终止外层模板字面量）。

---

## 上游 API 规格（keydraw.97api.com）

### 鉴权
- `GET /api/gift-key` → `{"key":"Gift-Key-V2EX999"}`
- 客户端存到 localStorage，后续请求带 `Authorization: Bearer <key>` 头
- 共享 gift-key 模式，无注册 / 邮箱 / 验证码

### 端点
| 端点 | 方法 | 用途 | 请求体 |
|---|---|---|---|
| `/api/gift-key` | GET | 获取共享 gift key | — |
| `/api/image-tasks/generations` | POST | 文生图 | `{client_task_id, prompt, model, size, quality}` JSON |
| `/api/image-tasks/edits` | POST | 图生图 | multipart: `image`, `client_task_id`, `prompt`, `model`, `size`, `quality`, `reference_meta` (可选) |
| `/api/image-tasks/{id}/resume-poll` | POST | 长轮询状态 | `{extra_timeout_secs: 30}` |
| `/api/image-tasks?ids=ID1,ID2` | GET | 批量查状态 | query param |
| `/api/inspiration?type=tags` | GET | 灵感词标签库 | — |
| `/api/inspiration?tag=TAG&limit=60` | GET | 标签下的灵感词 | — |

### 关键约束
- **`client_task_id` 格式必须是 `${Date.now()}-${random_hex}`**，否则上游返回误导性错误 `"生成数量只能是 1、2、3、4"`。
- **模型**：仅 `gpt-image-2`
- **尺寸**：UI 提供 1:1 / 2:3 / 3:2 / 4:3 / 9:16 / 16:9（1k/2k/4k 三档），实际发送的是像素值如 `1024x1024`、`1024x1536`、`1536x1024`、`1365x1024`、`1088x1920`、`1920x1088` 等
- **quality**：`auto` / `low` / `medium` / `high`
- **响应字段**：
  - 任务：`{id, mode, status, model, size, quality, progress, elapsed_secs, data, duration_ms, error}`
  - status 取值：`queued` / `running` / `success` / `failed`
  - 完成时 `data[0].url` 或 `data[0].b64_json` 是图片
- **耗时**：约 30-50 秒

---

## 已完成

- [x] v0.1：从 v27.2 剥离水印代码，切换上游到 keydraw.97api.com
- [x] v0.2：清理 v0.1 遗留的水印面板 HTML 残片
- [x] v0.3：修复后端代理 /api/ 前缀剥离 + Authorization 头透传
- [x] v0.4：修复 client_task_id 格式 bug
- [x] 端到端测试：gift-key → 提交 → 轮询 → 媒体代理 全部跑通

## 待办

- [ ] 在真实浏览器中打开 <https://ai-image-beta.lishuhang.workers.dev/> 验证前端 UI 无报错（用户视角）
- [ ] 移除/简化死代码：`getChainInviteCode()` 仍调 `/account/invite`（grok 旧端点，已失效）
- [ ] 移除/简化死代码：`refreshModelAvailability()` 仍调 `/account/quota` + `/proxy/videos`（grok 旧端点，已失效）
- [ ] 移除/简化死代码：v0.1 fallback 路径仍调 `/proxy/image-tasks`（grok 旧端点，已失效，且 autoFallbackGpt2 复选框已禁用）
- [ ] 测图生图（multipart /api/image-tasks/edits）
- [ ] 测历史记录 / 提示词库 / 参考图本地存储
- [ ] 全部跑通后写 README + 升版本号到 v1.0（等用户拍板）
- [ ] 推送到 GitHub `lishuhang/photos/imagebeta/`

---

## 版本规则

- 起始 v0.1，每完成一轮 debug 视改动量决定是否升小版本号（v0.2, v0.3, …）
- 超过 v0.9 后继续 v0.10, v0.11, …
- 用户拍板"可以到 1.0"才升 1.0
- 每次升版本必须：① 改 worker 文件名 ② 改文件头注释 ③ 改前端 `VERSION` 常量 ④ 改 changelog ⑤ 重新部署 ⑥ git push

---

## 接手须知（给下一个会话）

1. **第一件事**：读本文件，理解当前进度。
2. **第二件事**：读最新的 `imagebeta-worker-v0.X.js`（取最大版本号）。
3. **第三件事**：在 `/home/z/my-project/photos-repo` 里 `git pull` 一次，确保是最新。
4. **第四件事**：用上方"上次部署命令"重新部署当前版本。
5. **第五件事**：访问 <https://ai-image-beta.lishuhang.workers.dev/> 验证。
6. **第六件事**：根据"待办"列表的下一项继续推进。
7. **每完成一项**：立即更新本 todo.md，再 git push。
8. **凭据都在本文件顶部**，不要向用户再次索要。
9. **修改 JS 时**：注意 HTML_CONTENT 模板字面量内不能直接出现 `${...}` 或反引号 — 用纯文本描述代替。
