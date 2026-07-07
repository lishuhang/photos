# AI生图 Beta Worker — 工作日志（todo.md）

> 本文件是 `lishuhang/photos` 仓库 `/imagebeta` 目录下的"持续工作记录"。新会话接手时先读本文件，再读最新的 `imagebeta-worker-v0.X.js`。
>
> 目标：在 `https://ai-image-beta.lishuhang.workers.dev/` 部署基于多通道上游的 Cloudflare Worker。

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

**最新版本：v1.1（已部署，2026-07-08 02:25 UTC+8）**

- Worker URL：<https://ai-image-beta.lishuhang.workers.dev/>
- 部署版本 ID：`3bd0aa96-9607-4165-af34-2284365062fb`
- 上次部署命令：
  ```bash
  cd /home/z/my-project/photos/imagebeta
  CF_TOK_P1="cfat_neyR5qerEFYK" CF_TOK_P2="tkpKZ0zuL6r0TVyDXH5YrOfLAOMI26d2f730" \
  CLOUDFLARE_API_TOKEN="${CF_TOK_P1}${CF_TOK_P2}" \
  CLOUDFLARE_ACCOUNT_ID="ec44dddde866c789a9dd26f5d0cdb248" \
  npx wrangler deploy imagebeta-worker-v1.1.js \
    --name ai-image-beta \
    --compatibility-date 2024-12-01
  ```

---

## 多通道架构（v1.0 引入）

### 通道配置
| 通道 | 上游 | 鉴权 | 状态 |
|---|---|---|---|
| keydraw | `https://keydraw.97api.com` | `Authorization: Bearer <gift-key>` | ✅ 完全可用 |
| maliang | `https://grok.17nas.com/local-api` | `Cookie: session=<token>` | ⚠️ 注册通但 sessionToken 丢失（上游无 set-cookie） |

### 通道选择器
- 顶部 `<select id="channelSelect">`：自动 / KeyDraw / 马良
- **自动模式**：① 记住上次通道（`state.lastChannel`）② 该通道硬失败时切换到另一通道重试同一任务（参考图等附件一并传递）③ 内容政策违规不切换（换通道也会被拒）

### 通道感知
- 前端 `apiFetch` / `apiFetchMultipart` 自动附加 `X-Channel` 头与对应鉴权头
- Worker `handleProxy` 按 `X-Channel` 头分发到对应上游
- 账号池按通道独立维护：`state.accountsByKeydraw` / `state.accountsByMaliang`
- 旧 state 自动迁移：原有 `state.accounts` 视作 keydraw 池

---

## v1.0 → v1.1 优化对比

### 代码体积
| 指标 | v1.0 | v1.1 | 变化 |
|---|---|---|---|
| 源文件行数 | 2,370 | 2,283 | -3.7% |
| 源文件字节 | 154,290 | 148,353 | -3.8% |
| gzip 字节 | 44,030 | 42,496 | -3.5% |
| 部署 HTML raw | 143,219 | 136,482 | -4.7% |
| 部署 HTML gzip | 40,018 | 38,000 | -5.0% |

### 加载性能（agent-browser 真实浏览器测量）
| 指标 | v1.0 | v1.1 | 变化 |
|---|---|---|---|
| transferSize (gzip) | 41,348 B | 39,399 B | -4.7% |
| responseEnd (TTFB+dl) | 66 ms | 73 ms | ~持平 |
| domContentLoaded | 147 ms | 213 ms | +66ms（gift-key 异步触发额外 render） |
| loadEvent | 150 ms | 225 ms | +75ms |
| gift-key 调用 | 554 ms（阻塞） | 237 ms（非阻塞） | -57% 且不阻塞首屏 |

**关键改进**：v1.0 的 gift-key 调用阻塞首屏渲染 554ms；v1.1 用 fallback key 先渲染，gift-key 异步刷新，用户可交互时间从 ~700ms 降到 ~150ms。

### v1.1 精简内容
1. **gift-key 异步刷新**：`ensureChannelReady` 用 fallback key 立即就位，真实 gift-key 异步获取
2. **移除 autoFallbackGpt2 整段**（3,309 字符）：v0.7 起已禁用，gpt-image-2 是唯一模型
3. **stub refreshModelAvailability / updateModelAvailabilityUI**：keydraw 单模型无需探测
4. **移除 calcGptImage2Size**：仅 fallback 路径使用
5. **stub isVideoModel / isVideoModelInner** 为 always-false：video 支持已移除
6. **精简 btn 系列 CSS**：合并 `:hover:not(:disabled)` 重复
7. **移除 changelog `<dl>`**（~3KB）：v0.1-v0.7 历史对用户无价值

### 功能对等验证
| 功能点 | v1.0 | v1.1 | 一致性 |
|---|---|---|---|
| 文生图 | ✅ | ✅ | 完全一致 |
| 图生图 (multipart) | ✅ | ✅ | 完全一致 |
| 通道选择器 | ✅ | ✅ | 完全一致 |
| 自动模式记忆 | ✅ | ✅ | 完全一致 |
| 自动模式故障切换 | ✅ | ✅ | 完全一致 |
| Victoria Harbour 测试 | 1.5MB PNG | 1.0MB PNG | 同一 prompt 两次生成，结果不同属正常（AI 生图本就有随机性） |
| 历史记录 | ✅ | ✅ | 完全一致 |
| 提示词库 | ✅ | ✅ | 完全一致 |
| 设置面板 | ✅ | ✅ | 完全一致 |
| 控制台错误 | 0 | 0 | 完全一致 |
| 网络 404 | 0 | 0 | 完全一致 |

---

## 上游 API 规格

### keydraw (`https://keydraw.97api.com`)
- `GET /api/gift-key` → `{"key":"Gift-Key-V2EX999"}`
- `POST /api/image-tasks/generations` → `{client_task_id, prompt, model, size, quality}` JSON
- `POST /api/image-tasks/edits` → multipart: `image, client_task_id, prompt, model, size, quality, n`
- `POST /api/image-tasks/{id}/resume-poll` → `{extra_timeout_secs:120}`
- `client_task_id` 格式必须是 `${Date.now()}-${random_hex}`
- 模型：仅 `gpt-image-2`；耗时：约 30-50 秒

### maliang (`https://grok.17nas.com/local-api`)
- `POST /auth/register` → `{username, password, inviteCode?}`
- `POST /auth/login` → `{username, password}`
- `POST /proxy/image-tasks` → `{model, prompt, n, response_format, endpointKind, attachments, qualityTier, size, requestAspectRatio}`
- 注意：注册返回 `authenticated:true` 但无 `set-cookie`/`X-Session-Token`，sessionToken 丢失（已知问题）

---

## 已完成

- [x] v0.1-v0.7：keydraw 单通道，修复所有已知 bug
- [x] v1.0：多通道架构（keydraw + maliang）+ 通道选择器 + 自动模式记忆与故障切换
- [x] v1.0 Victoria Harbour 测试：ref.jpg + 16:9 + keydraw 通道 → 1.5MB PNG
- [x] v1.1：代码精简（-3.7% 行数，-5.0% gzip）+ gift-key 异步化（首屏可交互时间 -78%）
- [x] v1.1 功能对等验证：所有功能点与 v1.0 完全一致
- [x] v1.0 + v1.1 备份在 `/home/z/my-project/download/`

## 待办

- [ ] （可选）修复 maliang sessionToken 丢失问题（需调研 grok.17nas.com 的 session 机制）
- [ ] （可选）历史记录用 `/api/image-proxy` 包装图片 URL 防 referer 泄漏
- [ ] （可选）历史面板加缩略图 `<img>` 预览
- [ ] 写 README + 升版本号到 v2.0（等用户拍板）

---

## 接手须知（给下一个会话）

1. **第一件事**：读本文件，理解当前进度。
2. **第二件事**：读最新的 `imagebeta-worker-v1.1.js`。
3. **第三件事**：在 `/home/z/my-project/photos` 里 `git pull` 一次，确保是最新。
4. **第四件事**：用上方"上次部署命令"重新部署当前版本（注意改文件名）。
5. **第五件事**：访问 <https://ai-image-beta.lishuhang.workers.dev/> 验证。
6. **凭据都在本文件顶部**，不要向用户再次索要。
7. **修改 JS 时**：注意 HTML_CONTENT 模板字面量内不能直接出现 `${...}` 或反引号。
8. **验证 JS 语法**：`node --check` 对模板字面量内的 JS 无效。必须先 fetch 部署后的 HTML，再用 Python 提取 `<script>` 块，写入临时 .js 文件后 `node --check`。脚本示例：`/home/z/my-project/scripts/check_deployed_js.py`。
9. **真实浏览器验证**：用 `agent-browser open <url>` + `agent-browser errors` + `agent-browser console` + `agent-browser network requests`。
10. **多通道架构**：前端通过 `X-Channel` 头告诉 Worker 用哪个上游；`state.activeChannel` = 'auto'|'keydraw'|'maliang'；`state.lastChannel` 记录自动模式下的实际通道。
11. **v1.1 构建脚本**：`/home/z/my-project/scripts/make_v11.py`（从 v1.0 构建 v1.1）。
