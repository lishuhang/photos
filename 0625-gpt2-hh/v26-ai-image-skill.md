---
name: ai-image-generation
version: v26
description: |
  通过 Cloudflare Worker 代理（https://ai-image.lishuhang.workers.dev）调用上游 grok.17nas.com 的 AI 生图服务，
  基于给定账号池实现批量提示词按默认配置自动出图。无前端依赖，纯 API 调用，适合 AI agent 直接调用。
  v25 适配上游计费模型变更：签到已下线，账号变为一次性即抛型；按"可生成图片数"而非原始 credits 计算；
  余额不足账号自动移入废弃池；支持多账号轮换、并发生成、自动登录恢复、余额耗尽自动换号、失败重试与回退。
triggers:
  - 批量生成图片
  - 自动出图
  - AI 生图
  - 调用 grok.17nas.com
  - 调用 ai-image worker
  - 用账号池生图
  - batch image generation
  - generate images from prompts
output_format: png/jpg files saved to disk, plus a JSON manifest with metadata
language: python
---

# AI Image Generation Skill (v26)

> **Skill ID**: `ai-image-generation` v26
> **Worker Endpoint**: `https://ai-image.lishuhang.workers.dev` (已部署 v26 worker)
> **Upstream**: `https://grok.17nas.com/local-api`（必须经 worker 代理，直连会被 Cloudflare 拦截）
> **Source Reference**: `worker_v26.js` (2135 行，已部署)

## 1. Skill 概述

本 skill 让 AI agent 在**无前端**的情况下，通过 worker 代理调用上游 AI 生图服务。Agent 提供：

- **账号池**（username/password 列表）
- **提示词列表**（一行一个或 JSON 数组）

Skill 自动完成：

1. 登录所有账号，获取 session token
2. 查询每个账号的剩余余额（imageCredits），计算可生成图片数
3. **自动过滤余额不足账号**（credits < 单张成本），移入废弃池
4. 按默认配置（gpt-image-2, 1024×1024, 1:1）批量提交生图任务
5. 多账号 × 每账号 3 并发 槽位并行处理
6. 轮询任务状态直到完成或超时（300s）
7. 下载生成的图片到本地磁盘
8. 输出 JSON 清单（每条提示词对应的图片路径、状态、所用账号、耗时）
9. 全程自动处理：session 过期自动重新登录、余额耗尽自动换号并标记废弃、失败自动重试 3 次

### v25 计费模型说明

上游 grok.17nas.com 的计费体系：

- **imageCredits** 仍是用户余额字段（1 credit = ¥0.1）
- 新账号注册赠送 **¥1 = 10 credits**
- gpt-image-2 standard 单张成本 **3 credits = ¥0.3**
- **签到已下线** → 老账号余额无法补充，**账号变为一次性即抛型**
- 余额不足（<3 credits）的账号无法生成任何图片，应移入废弃池

**v25 关键变更**：

| 变更点 | v24 行为 | v25 行为 |
|--------|----------|----------|
| 余额显示 | 显示原始 credits | 显示"可生成图片数"（credits ÷ 单张成本） |
| 账号选择 | credits > 0 即可选 | canGenerateAtLeastOne() = credits ≥ 单张成本 |
| 余额不足处理 | 标记 exhausted，换号 | 自动移入废弃池 + 换号 |
| refreshQuota | 仅更新 credits | 余额不足时自动移入废弃池 |
| 错误提示 | "请先签到或充值" | "请注册新账号或充值" |

### 关键约束

| 约束 | 说明 |
|------|------|
| **必须经 worker 代理** | 直连 `grok.17nas.com` 会被 Cloudflare 返回 403 challenge 页面，无法绕过 |
| **Session token 通过请求头传递** | `X-Session-Token: <token>`（worker 自动转为上游所需的 Cookie） |
| **签到功能已下线** | 上游 `/account/checkin` 接口已失效，额度只能靠注册赠送（¥1=10张）或充值 |
| **每账号默认并发 3** | 上游限制每账号最多 3 个并发任务，多账号可叠加 |
| **任务超时 300 秒** | 上游 hard limit，超时后任务自动失败并退还额度 |
| **额度不足时自动失败并退款** | 上游在生成失败（除内容违规外）会自动退还 credits |

## 2. 前置条件

### 2.1 账号池格式

Agent 调用本 skill 时，需提供账号池。两种格式均可：

**格式 A：JSON 文件**
```json
{
  "accounts": [
    {"username": "user1", "password": "pass1"},
    {"username": "user2", "password": "pass2"}
  ]
}
```

**格式 B：JSON 数组**
```json
[
  {"username": "user1", "password": "pass1"},
  {"username": "user2", "password": "pass2"}
]
```

### 2.2 提示词格式

**格式 A：文本文件（每行一个）**
```
a cute orange cat sitting on a wooden chair
cyberpunk city at night with neon lights
watercolor painting of a mountain landscape
```

**格式 B：JSON 数组**
```json
[
  "a cute orange cat sitting on a wooden chair",
  "cyberpunk city at night with neon lights"
]
```

**格式 C：带 ID 的对象数组（推荐，便于追踪）**
```json
[
  {"id": "cat_001", "prompt": "a cute orange cat"},
  {"id": "city_002", "prompt": "cyberpunk city at night"}
]
```

### 2.3 运行环境

- Python 3.8+
- `requests` 库（`pip install requests`）
- 可访问 `https://ai-image.lishuhang.workers.dev`

## 3. 默认配置

Skill 默认使用以下配置出图（可通过参数覆盖）：

```python
DEFAULT_CONFIG = {
    "model": "gpt-image-2",          # 模型：gpt-image-2 / grok-imagine-image / grok-imagine-image-pro / grok-imagine-image-lite / grok-imagine-image-edit / grok-imagine-video
    "size": "1024x1024",              # 图片尺寸
    "ratio": "1:1",                   # 宽高比（与 size 二选一，size 优先）
    "quality_tier": "standard",       # 画质档位：standard(1.5K) / high(2.5K) / ultra(4K)
    "count": 1,                       # 每条提示词生成几张
    "response_format": "b64_json",    # b64_json / url
    "endpoint_kind": "generations",   # generations(文生图) / edits(图生图，需附件)
    "concurrent_per_account": 3,      # 每账号并发数（上游硬限制）
    "poll_interval_sec": 3,           # 轮询间隔
    "task_timeout_sec": 300,          # 单任务超时
    "max_retries": 3,                 # 单任务最大重试次数
    "auto_fallback_gpt2": True,       # 其他模型失败时自动换 gpt-image-2 重试
}
```

### 模型与单价参考（来自上游 system 配置）

> ⚠️ **重要**：经实测，上游 token 当前**仅授权访问 `gpt-image-2`**。其他 grok-imagine-* 模型在提交时会返回 `403 This token has no access to model`。下表中的其他模型仅供参考，实际不可用。建议始终使用 `gpt-image-2`。

| 模型 | 单张成本（credits） | 单张成本（元） | 支持参考图 | 当前可用 |
|------|---------------------|----------------|------------|----------|
| **gpt-image-2** | 3 (standard) / 8 (high) / 30 (ultra) | ¥0.3 / ¥0.8 / ¥3.0 | ✓ | ✅ **推荐** |
| grok-imagine-image | 0.4 | ¥0.04 | ✗ | ❌ 403 |
| grok-imagine-image-pro | 1 | ¥0.1 | ✗ | ❌ 403 |
| grok-imagine-image-lite | 0.2 | ¥0.02 | ✗ | ❌ 403 |
| grok-imagine-image-edit | 0.4 | ¥0.04 | ✓ | ❌ 403 |
| grok-imagine-video | 5/8/10/13/16（按时长） | ¥0.5~¥1.6 | ✓ | 待验证 |

新账号注册赠送 ¥1 = 10 张 gpt-image-2 standard 额度（每张 3 credits，10 credits 可生成约 3 张图）。

**实测结果**（v1 skill 验证）：
- 单账号（10 credits）生成 1 张 gpt-image-2 standard 1:1 图片耗时约 45 秒
- 上游实际返回 2 张图片（虽然请求 n=1，但上游有时会返回多张候选）
- 返回的图片为 1254×1254 PNG，约 810 KB

## 4. API 参考

所有请求均发送到 worker：`https://ai-image.lishuhang.workers.dev/api/<path>`

### 4.1 登录

```
POST /api/auth/login
Content-Type: application/json

Body: {"username": "...", "password": "..."}

Response 200:
  Headers: X-Session-Token: auth_xxxxxxxxxxxxxxxx
  Body: {"ok": true, "user": {"id": "...", "username": "...", "imageCredits": 10, ...}, "system": {...}}

Response 4xx:
  Body: {"error": "用户名或密码错误"}
```

### 4.2 查询额度

```
GET /api/account/quota
X-Session-Token: <token>

Response 200:
  Body: {"ok": true, "user": {..., "imageCredits": N, ...}, "system": {...}}

Response 401:
  Body: {"error": "请先登录"}  ← 需重新登录
```

### 4.3 提交生图任务

```
POST /api/proxy/image-tasks
X-Session-Token: <token>
Content-Type: application/json

Body:
{
  "model": "gpt-image-2",
  "prompt": "提示词文本",
  "n": 1,
  "response_format": "b64_json",
  "endpointKind": "generations",
  "attachments": [],
  "qualityTier": "standard",
  "size": "1024x1024",
  "requestAspectRatio": "1:1"
}

Response 200:
  Body: {
    "task": {
      "id": "imgtask_xxxxxxxxxxxxx",
      "status": "queued",        // queued / running / succeeded / failed
      "progress": 8,
      "model": "gpt-image-2",
      "size": "1024x1024",
      ...
    },
    "user": {"imageCredits": 7, ...}   // 扣费后的剩余额度
  }

Response 4xx (额度不足):
  Body: {"error": "账户余额不足，请先充值或填写自己的 Bearer Token"}

Response 401 (会话过期):
  Body: {"error": "请先登录"}  ← 需重新登录后重试
```

**图生图（参考图）请求体**：
```json
{
  "model": "gpt-image-2",
  "prompt": "把这张图改成赛博朋克风格",
  "n": 1,
  "response_format": "b64_json",
  "endpointKind": "edits",
  "attachments": [
    {
      "name": "ref_0.png",
      "type": "image/png",
      "dataUrl": "data:image/png;base64,<BASE64_DATA>"
    }
  ],
  "qualityTier": "standard",
  "size": "1024x1024"
}
```

### 4.4 轮询任务状态

```
GET /api/proxy/image-tasks/<task_id>
X-Session-Token: <token>

Response 200:
  Body: {
    "task": {
      "id": "...",
      "status": "succeeded",     // succeeded 时 payload 含图片数据
      "progress": 100,
      "payload": {
        "data": [
          {"url": "https://..."},           // 远程 URL（需代理下载）
          {"b64_json": "<base64_string>"}   // 或 base64 直传
        ],
        "markdown": "![image](https://...)"  // 部分模型用 markdown 返回
      },
      "resultUrls": ["https://..."],         // 备用字段
      "error": "",                            // 失败时的错误信息
      "quota": {"refunded": true/false, ...} // 失败时是否退款
    },
    "user": {"imageCredits": N, ...}
  }

Response 401:
  Body: {"error": "请先登录"}  ← 需重新登录后继续轮询（任务仍可访问）
```

### 4.5 媒体代理（下载图片）

如果任务返回的是 URL 而非 base64，需通过 worker 代理下载（直连上游 URL 会 401）：

```
GET /api/media-proxy?url=<encoded_url>&token=<session_token>

Response 200:
  Body: <binary image data>
  Content-Type: image/png
```

或使用请求头传 token：

```
GET /api/media-proxy?url=<encoded_url>
X-Session-Token: <token>
```

### 4.6 视频任务（可选）

```
POST /api/proxy/videos
Body: {"model": "grok-imagine-video", "prompt": "...", "seconds": 6, "n": 1, "size": "1024x1024", "resolution_name": "720p"}

GET /api/proxy/videos/<task_id>
DELETE /api/proxy/videos/<task_id>   # 取消任务
```

## 5. 完整工作流

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. 加载账号池 + 提示词列表                                            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. 并发登录所有账号，保存 {username: session_token} 映射              │
│    失败账号跳过（冷却 5 分钟，连续失败 2 次移入废弃池）                │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. 查询每个账号的 imageCredits，构建可用账号列表（按 credits 降序）   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. 提交所有提示词任务到任务队列                                       │
│    - 总并发 = 可用账号数 × 3                                          │
│    - 每个任务选 credits 最多的账号                                    │
│    - 提交失败：session 过期→重登录；额度不足→换号；其他→重试 3 次      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. 轮询所有运行中任务（每 3 秒一轮，最多 300 秒）                     │
│    - 状态 succeeded → 提取图片数据（URL 或 b64）                      │
│    - 状态 failed → 记录错误，必要时回退 gpt-image-2 重试              │
│    - 超时 → 标记 timeout                                              │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. 下载所有图片到 /home/z/my-project/download/images/<timestamp>/    │
│    - URL 类型通过 media-proxy 下载                                    │
│    - b64 类型直接解码保存                                             │
└──────────────────────────────────┬──────────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 7. 输出 manifest.json（每条提示词的最终状态、图片路径、账号、耗时）    │
└─────────────────────────────────────────────────────────────────────┘
```

## 6. 参考实现（Python）

以下脚本为本 skill 的完整可执行实现。Agent 可直接保存为 `/home/z/my-project/scripts/ai_image_skill.py` 并运行。

```python
#!/usr/bin/env python3
"""
AI Image Generation Skill (v1)
通过 worker 代理批量生成图片。
用法:
  python ai_image_skill.py --accounts accounts.json --prompts prompts.txt
  python ai_image_skill.py --accounts accounts.json --prompts prompts.json --output ./out
"""
import argparse
import base64
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

import requests

WORKER_BASE = "https://ai-image.lishuhang.workers.dev"

# ============== 默认配置 ==============
DEFAULT_CONFIG = {
    "model": "gpt-image-2",
    "size": "1024x1024",
    "ratio": "1:1",
    "quality_tier": "standard",
    "count": 1,
    "response_format": "b64_json",
    "endpoint_kind": "generations",
    "concurrent_per_account": 3,
    "poll_interval_sec": 3,
    "task_timeout_sec": 300,
    "max_retries": 3,
    "auto_fallback_gpt2": True,
}


@dataclass
class Account:
    username: str
    password: str
    session_token: str = ""
    credits: int = 0
    disabled: bool = False
    cooldown_until: float = 0.0
    fail_count: int = 0


@dataclass
class PromptItem:
    id: str
    prompt: str
    # 运行时填充
    status: str = "queued"          # queued / running / success / failed / timeout
    task_id: str = ""
    account: str = ""
    image_paths: list = field(default_factory=list)
    error: str = ""
    started_at: float = 0.0
    completed_at: float = 0.0
    model_used: str = ""
    retries: int = 0


# ============== 工具函数 ==============
def is_auth_error(msg: str) -> bool:
    if not msg:
        return False
    msg = str(msg)
    return any(kw in msg for kw in [
        "请先登录", "未登录", "会话已过期", "无效会话",
        "token expired", "session expired", "unauthorized", "请重新登录"
    ])


def is_quota_error(msg: str) -> bool:
    if not msg:
        return False
    return "insufficient_quota" in msg or "额度不足" in msg or "余额不足" in msg


# ============== API 客户端 ==============
class AIClient:
    def __init__(self, account: Account, config: dict):
        self.account = account
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})

    def _headers(self) -> dict:
        h = {}
        if self.account.session_token:
            h["X-Session-Token"] = self.account.session_token
        return h

    def login(self) -> bool:
        """登录账号，获取 session token"""
        try:
            r = self.session.post(
                f"{WORKER_BASE}/api/auth/login",
                json={"username": self.account.username, "password": self.account.password},
                timeout=30
            )
            if not r.ok:
                self.account.fail_count += 1
                return False
            token = r.headers.get("X-Session-Token", "")
            if not token:
                return False
            self.account.session_token = token
            data = r.json()
            self.account.credits = data.get("user", {}).get("imageCredits", 0)
            self.account.fail_count = 0
            return True
        except Exception as e:
            print(f"[login] {self.account.username} error: {e}", file=sys.stderr)
            self.account.fail_count += 1
            return False

    def refresh_quota(self) -> bool:
        """刷新额度。session 过期自动重新登录"""
        if not self.account.session_token:
            return self.login()
        try:
            r = self.session.get(
                f"{WORKER_BASE}/api/account/quota",
                headers=self._headers(),
                timeout=30
            )
            if r.status_code == 401 or is_auth_error(r.json().get("error", "")):
                self.account.session_token = ""
                return self.login()
            if not r.ok:
                return False
            data = r.json()
            self.account.credits = data.get("user", {}).get("imageCredits", 0)
            return True
        except Exception as e:
            print(f"[refresh_quota] {self.account.username} error: {e}", file=sys.stderr)
            return False

    def submit_task(self, prompt: str, model: str = None, size: str = None,
                    ref_images: list = None):
        """提交生图任务。返回 (task_dict_or_None, error_msg_str)。
        成功时 error_msg 为空字符串；失败时 task 为 None，error_msg 含原因。
        这样调用方可以区分额度不足（应换号）和其他错误（应重试）。
        """
        model = model or self.config["model"]
        size = size or self.config["size"]
        body = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "response_format": self.config["response_format"],
            "endpointKind": "edits" if ref_images else "generations",
            "attachments": [],
            "qualityTier": self.config["quality_tier"],
            "size": size,
        }
        if self.config["ratio"] != "auto":
            body["requestAspectRatio"] = self.config["ratio"]
        if ref_images:
            for i, img_b64 in enumerate(ref_images):
                body["attachments"].append({
                    "name": f"ref_{i}.png",
                    "type": "image/png",
                    "dataUrl": f"data:image/png;base64,{img_b64}" if not img_b64.startswith("data:") else img_b64
                })

        try:
            r = self.session.post(
                f"{WORKER_BASE}/api/proxy/image-tasks",
                json=body,
                headers=self._headers(),
                timeout=30
            )
            data = r.json()
            if not r.ok:
                err = data.get("error") or data.get("message") or f"HTTP {r.status_code}"
                # 检查 session 过期
                if is_auth_error(err):
                    if self.login():  # 重新登录后重试一次
                        return self.submit_task(prompt, model, size, ref_images)
                    return None, "relogin failed"
                return None, err
            task = data.get("task", {})
            # 更新额度
            if data.get("user"):
                self.account.credits = data["user"].get("imageCredits", self.account.credits)
            return task, ""
        except Exception as e:
            print(f"[submit_task] {self.account.username} error: {e}", file=sys.stderr)
            return None, str(e)

    def poll_task(self, task_id: str, timeout_sec: int = None) -> Optional[dict]:
        """轮询任务直到完成或超时。返回完整 task dict 或 None"""
        timeout_sec = timeout_sec or self.config["task_timeout_sec"]
        deadline = time.time() + timeout_sec
        consecutive_errors = 0

        while time.time() < deadline:
            time.sleep(self.config["poll_interval_sec"])
            try:
                r = self.session.get(
                    f"{WORKER_BASE}/api/proxy/image-tasks/{task_id}",
                    headers=self._headers(),
                    timeout=30
                )
                data = r.json()
                if not r.ok:
                    err = data.get("error", "")
                    if is_auth_error(err):
                        if self.login():  # 重新登录后继续轮询
                            consecutive_errors = 0
                            continue
                    consecutive_errors += 1
                    if consecutive_errors >= 5:
                        return None
                    continue

                task = data.get("task", {})
                status = task.get("status", "")
                # 更新额度
                if data.get("user"):
                    self.account.credits = data["user"].get("imageCredits", self.account.credits)

                if status == "succeeded":
                    return task
                if status == "failed":
                    return task  # 返回失败任务，调用方判断 error 字段
                # 否则继续轮询
                consecutive_errors = 0
            except Exception as e:
                print(f"[poll_task] {self.account.username} error: {e}", file=sys.stderr)
                consecutive_errors += 1
                if consecutive_errors >= 5:
                    return None
        return None  # 超时

    def download_image(self, url: str, save_path: Path) -> bool:
        """通过 worker media-proxy 下载图片"""
        try:
            proxy_url = f"{WORKER_BASE}/api/media-proxy?url={urllib.parse.quote(url, safe='')}"
            r = self.session.get(
                proxy_url,
                headers=self._headers(),
                timeout=60
            )
            if not r.ok:
                return False
            save_path.parent.mkdir(parents=True, exist_ok=True)
            with open(save_path, "wb") as f:
                f.write(r.content)
            return True
        except Exception as e:
            print(f"[download_image] error: {e}", file=sys.stderr)
            return False


# ============== 账号池管理 ==============
class AccountPool:
    def __init__(self, accounts: list, config: dict):
        self.accounts = [Account(**a) for a in accounts]
        self.config = config
        self.exhausted = set()  # 已耗尽额度的用户名

    def login_all(self):
        """并发登录所有账号"""
        print(f"[pool] 登录 {len(self.accounts)} 个账号...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futures = {ex.submit(self._login_one, i): i for i in range(len(self.accounts))}
            for f in concurrent.futures.as_completed(futures):
                idx = futures[f]
                try:
                    f.result()
                except Exception as e:
                    print(f"[pool] 账号 {self.accounts[idx].username} 登录异常: {e}")
        ok = sum(1 for a in self.accounts if a.session_token and not a.disabled)
        print(f"[pool] 登录完成: {ok}/{len(self.accounts)} 成功")

    def _login_one(self, idx: int):
        acc = self.accounts[idx]
        client = AIClient(acc, self.config)
        if client.login():
            print(f"  ✓ {acc.username} (credits={acc.credits})")
        else:
            print(f"  ✗ {acc.username} 登录失败")

    def select_account(self) -> Optional[Account]:
        """选择 credits 最多且未被耗尽的账号"""
        candidates = [
            a for a in self.accounts
            if a.session_token and not a.disabled
            and a.credits > 0 and a.username not in self.exhausted
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda a: a.credits)

    def mark_exhausted(self, username: str):
        self.exhausted.add(username)
        for a in self.accounts:
            if a.username == username:
                a.credits = 0


# ============== 任务执行器 ==============
class BatchGenerator:
    def __init__(self, pool: AccountPool, prompts: list, config: dict, output_dir: Path):
        self.pool = pool
        self.prompts = prompts  # list[PromptItem]
        self.config = config
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.active_count = 0
        self.lock = __import__("threading").Lock()

    def max_concurrency(self) -> int:
        ok = [a for a in self.pool.accounts if a.session_token and not a.disabled and a.credits > 0]
        return len(ok) * self.config["concurrent_per_account"]

    def process_one(self, item: PromptItem):
        """处理单个提示词：提交→轮询→下载"""
        self.lock.acquire()
        self.active_count += 1
        self.lock.release()

        try:
            item.started_at = time.time()
            self._generate_with_retry(item)
        finally:
            item.completed_at = time.time()
            self.lock.acquire()
            self.active_count -= 1
            self.lock.release()

    def _generate_with_retry(self, item: PromptItem):
        retry = 0
        max_retries = self.config["max_retries"]
        models_to_try = [self.config["model"]]
        if self.config["auto_fallback_gpt2"] and self.config["model"] != "gpt-image-2":
            models_to_try.append("gpt-image-2")

        for model in models_to_try:
            while retry <= max_retries:
                acc = self.pool.select_account()
                if not acc:
                    item.status = "failed"
                    item.error = "no available account (all exhausted or no credits)"
                    return

                client = AIClient(acc, self.config)
                item.account = acc.username
                item.status = "running"
                print(f"[gen] {item.id} → {acc.username} (model={model}, retry={retry}, credits={acc.credits})")

                task, submit_err = client.submit_task(item.prompt, model=model)
                if not task:
                    # 提交失败：检测额度不足 → 标记账号并换号（不增加 retry）
                    if is_quota_error(submit_err):
                        self.pool.mark_exhausted(acc.username)
                        print(f"[gen] {acc.username} 额度不足（{submit_err[:60]}），换号重试")
                        continue
                    # 检测模型无访问权限 → 跳到下一个模型
                    if "no access to model" in submit_err or "无权访问" in submit_err:
                        print(f"[gen] 账号无权访问模型 {model}，跳过该模型")
                        item.error = submit_err
                        break  # 跳出 while，让 for 进入下一个模型
                    # 其他错误 → 重试
                    item.error = submit_err
                    retry += 1
                    item.retries = retry
                    time.sleep(1.5)
                    continue

                task_id = task.get("id")
                if not task_id:
                    retry += 1
                    item.retries = retry
                    continue

                item.task_id = task_id
                result = client.poll_task(task_id)
                if not result:
                    item.status = "timeout"
                    item.error = "task timeout (300s) or polling failed"
                    retry += 1
                    item.retries = retry
                    time.sleep(1.5)
                    continue

                if result.get("status") == "succeeded":
                    images = self._extract_images(result)
                    if images:
                        item.status = "success"
                        item.model_used = result.get("model", model)
                        item.image_paths = self._save_images(item, images, acc)
                        print(f"[gen] {item.id} ✓ 生成 {len(item.image_paths)} 张图")
                        return
                    else:
                        item.status = "failed"
                        item.error = "succeeded but no images extracted"
                else:
                    err = result.get("error", "unknown failure")
                    if is_quota_error(err):
                        self.pool.mark_exhausted(acc.username)
                        print(f"[gen] {acc.username} 额度不足，换号重试")
                        continue  # 不增加 retry
                    item.error = err
                    retry += 1
                    item.retries = retry
                    time.sleep(1.5)
                    continue

            # 当前模型重试耗尽或无权限，尝试下一个模型（回退）
            if model != models_to_try[-1]:
                print(f"[gen] {item.id} 模型 {model} 失败，回退到 gpt-image-2")
                retry = 0
                continue
            else:
                item.status = "failed"
                return

    def _extract_images(self, task: dict) -> list:
        """从任务结果提取图片数据，返回 [{type: 'url'|'b64', value: '...'}, ...]"""
        def resolve_url(v):
            """将相对 URL 解析为完整 URL（与 worker v24 行为一致）"""
            if not v:
                return v
            if v.startswith("data:") or v.startswith("http://") or v.startswith("https://"):
                return v
            if v.startswith("/"):
                return "https://grok.17nas.com" + v
            return v

        images = []
        payload = task.get("payload") or {}
        # data 字段
        for item in payload.get("data", []):
            if item.get("url"):
                images.append({"type": "url", "value": resolve_url(item["url"])})
            elif item.get("b64_json"):
                images.append({"type": "b64", "value": f"data:image/png;base64,{item['b64_json']}"})
        # resultUrls 字段
        for u in task.get("resultUrls", []) or []:
            if u and not any(i["value"] == u for i in images):
                images.append({"type": "url", "value": resolve_url(u)})
        # markdown 字段
        md = payload.get("markdown", "")
        if md:
            for m in re.finditer(r"!\[.*?\]\((.*?)\)", md):
                url = m.group(1)
                if url.startswith("data:"):
                    images.append({"type": "b64", "value": url})
                elif not any(i["value"] == url for i in images):
                    images.append({"type": "url", "value": resolve_url(url)})
        # markdown 中的纯链接
        if md and not images:
            for m in re.finditer(r"https?://[^\s)]+\.(png|jpg|mp4|webp)", md):
                url = m.group(0)
                if url.startswith("data:"):
                    images.append({"type": "b64", "value": url})
                else:
                    images.append({"type": "url", "value": url})
        return images

    def _save_images(self, item: PromptItem, images: list, acc: Account) -> list:
        """保存图片到磁盘，返回路径列表"""
        saved = []
        for idx, img in enumerate(images):
            ext = "png"
            if img["type"] == "url":
                # 从 URL 推断扩展名
                m = re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", img["value"], re.I)
                if m:
                    ext = m.group(1).lower()
                    if ext == "jpeg":
                        ext = "jpg"
            save_path = self.output_dir / f"{item.id}_{idx}.{ext}"
            if img["type"] == "b64":
                # base64 直存
                b64_data = img["value"].split(",", 1)[-1] if img["value"].startswith("data:") else img["value"]
                try:
                    save_path.parent.mkdir(parents=True, exist_ok=True)
                    with open(save_path, "wb") as f:
                        f.write(base64.b64decode(b64_data))
                    saved.append(str(save_path))
                except Exception as e:
                    print(f"[save] {item.id} b64 解码失败: {e}")
            else:
                # URL 通过 worker media-proxy 下载
                client = AIClient(acc, self.config)
                if client.download_image(img["value"], save_path):
                    saved.append(str(save_path))
                else:
                    print(f"[save] {item.id} url 下载失败: {img['value']}")
        return saved

    def run(self):
        """批量执行所有提示词"""
        max_c = self.max_concurrency()
        print(f"[batch] 共 {len(self.prompts)} 个任务，最大并发 {max_c}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, max_c)) as ex:
            futures = {ex.submit(self.process_one, p): p for p in self.prompts}
            for f in concurrent.futures.as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    print(f"[batch] 任务异常: {e}")


# ============== I/O 工具 ==============
def load_accounts(path: str) -> list:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("accounts", [])
    raise ValueError(f"无法解析账号文件: {path}")


def load_prompts(path: str) -> list:
    """支持 .txt（每行一个）和 .json（数组或对象数组）"""
    p = Path(path)
    if p.suffix.lower() == ".json":
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        items = []
        for i, item in enumerate(data):
            if isinstance(item, str):
                items.append(PromptItem(id=f"img_{i:04d}", prompt=item))
            elif isinstance(item, dict):
                pid = item.get("id") or f"img_{i:04d}"
                items.append(PromptItem(id=str(pid), prompt=item.get("prompt", "")))
        return items
    else:
        with open(p, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        return [PromptItem(id=f"img_{i:04d}", prompt=line) for i, line in enumerate(lines)]


def write_manifest(items: list, output_dir: Path):
    manifest = []
    for it in items:
        d = asdict(it)
        d["duration_sec"] = round(it.completed_at - it.started_at, 2) if it.completed_at > it.started_at else 0
        manifest.append(d)
    manifest_path = output_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[manifest] 已写入 {manifest_path}")


# ============== 主入口 ==============
def main():
    parser = argparse.ArgumentParser(description="AI Image Generation Skill v1")
    parser.add_argument("--accounts", required=True, help="账号池 JSON 文件路径")
    parser.add_argument("--prompts", required=True, help="提示词文件（.txt 或 .json）")
    parser.add_argument("--output", default="/home/z/my-project/download/images",
                        help="图片输出目录（默认 /home/z/my-project/download/images）")
    parser.add_argument("--model", default=None, help="覆盖默认模型")
    parser.add_argument("--size", default=None, help="覆盖默认尺寸（如 1024x1024）")
    parser.add_argument("--ratio", default=None, help="覆盖默认比例（如 16:9）")
    parser.add_argument("--quality", default=None, choices=["standard", "high", "ultra"])
    parser.add_argument("--count", type=int, default=None, help="每条提示词生成几张")
    args = parser.parse_args()

    config = DEFAULT_CONFIG.copy()
    if args.model: config["model"] = args.model
    if args.size: config["size"] = args.size
    if args.ratio: config["ratio"] = args.ratio
    if args.quality: config["quality_tier"] = args.quality
    if args.count: config["count"] = args.count

    output_dir = Path(args.output) / time.strftime("%Y%m%d_%H%M%S")

    # 1. 加载账号池和提示词
    accounts = load_accounts(args.accounts)
    prompts = load_prompts(args.prompts)
    # 展开 count
    expanded = []
    for p in prompts:
        expanded.append(p)
        for i in range(1, config["count"]):
            expanded.append(PromptItem(id=f"{p.id}_{i}", prompt=p.prompt))

    print(f"=== AI Image Generation Skill v1 ===")
    print(f"账号数: {len(accounts)}")
    print(f"提示词数: {len(prompts)} (展开后 {len(expanded)} 任务)")
    print(f"配置: {config}")
    print(f"输出目录: {output_dir}")
    print()

    # 2. 登录所有账号
    pool = AccountPool(accounts, config)
    pool.login_all()

    # 3. 批量生成
    generator = BatchGenerator(pool, expanded, config, output_dir)
    generator.run()

    # 4. 输出清单
    write_manifest(expanded, output_dir)

    # 5. 汇总
    ok = sum(1 for p in expanded if p.status == "success")
    failed = sum(1 for p in expanded if p.status == "failed")
    timeout = sum(1 for p in expanded if p.status == "timeout")
    print()
    print(f"=== 完成 ===")
    print(f"成功: {ok}, 失败: {failed}, 超时: {timeout}")
    print(f"输出目录: {output_dir}")


if __name__ == "__main__":
    main()
```

### 使用示例

**示例 1：基础批量出图**
```bash
python /home/z/my-project/scripts/ai_image_skill.py \
  --accounts /path/to/accounts.json \
  --prompts /path/to/prompts.txt
```

**示例 2：使用 Grok-Image 模型（更便宜，0.4 credits/张）**
```bash
python /home/z/my-project/scripts/ai_image_skill.py \
  --accounts /path/to/accounts.json \
  --prompts /path/to/prompts.json \
  --model grok-imagine-image \
  --size 1024x1024
```

**示例 3：高清 4K 出图**
```bash
python /home/z/my-project/scripts/ai_image_skill.py \
  --accounts /path/to/accounts.json \
  --prompts /path/to/prompts.txt \
  --model gpt-image-2 \
  --quality ultra \
  --size 2816x2816
```

**示例 4：在 agent 代码中直接调用（不通过命令行）**
```python
import sys
sys.path.insert(0, "/home/z/my-project/scripts")
from ai_image_skill import AccountPool, BatchGenerator, PromptItem, DEFAULT_CONFIG, load_accounts

accounts = load_accounts("/path/to/accounts.json")
prompts = [
    PromptItem(id="cat_001", prompt="a cute orange cat"),
    PromptItem(id="city_002", prompt="cyberpunk city at night"),
]

config = DEFAULT_CONFIG.copy()
pool = AccountPool(accounts, config)
pool.login_all()

from pathlib import Path
gen = BatchGenerator(pool, prompts, config, Path("/home/z/my-project/download/images/inline"))
gen.run()

for p in prompts:
    if p.status == "success":
        print(f"{p.id}: {p.image_paths}")
```

## 7. 输出规范

### 7.1 文件结构

```
/home/z/my-project/download/images/<YYYYMMDD_HHMMSS>/
├── manifest.json              # 任务清单
├── img_0000_0.png             # 第 1 个任务的第 1 张图
├── img_0000_1.png             # 第 1 个任务的第 2 张图（如 count > 1）
├── img_0001_0.png             # 第 2 个任务的第 1 张图
└── ...
```

### 7.2 manifest.json 结构

v25 起 manifest.json 改为对象结构，包含 summary、tasks、abandoned_accounts 三个字段：

```json
{
  "summary": {
    "total_prompts": 2,
    "success": 1,
    "failed": 1,
    "timeout": 0
  },
  "tasks": [
    {
      "id": "img_0001",
      "prompt": "a cute orange cat sitting on a wooden chair",
      "status": "success",
      "task_id": "imgtask_xxxxxxxxxxxxx",
      "account": "avacarter374",
      "image_paths": [
        "/home/z/my-project/download/images/20260625_120000/img_0001_0.png"
      ],
      "error": "",
      "started_at": 1782389414.985,
      "completed_at": 1782389713.585,
      "model_used": "gpt-image-2",
      "retries": 0,
      "duration_sec": 298.6
    },
    {
      "id": "img_0002",
      "prompt": "cyberpunk city",
      "status": "failed",
      "task_id": "imgtask_yyyyyyyyyyyy",
      "account": "brianClark15",
      "image_paths": [],
      "error": "账户余额不足，请注册新账号或充值",
      "started_at": 1782389415.123,
      "completed_at": 1782389715.456,
      "model_used": "gpt-image-2",
      "retries": 3,
      "duration_sec": 300.33
    }
  ],
  "abandoned_accounts": [
    {
      "username": "brianClark15",
      "password": "Ml@2026Proxy260621",
      "credits": 1,
      "reason": "余额不足（1 credits < 3）",
      "abandoned_at": 1782389410.123
    },
    {
      "username": "jasonharris72",
      "password": "Ml@2026Proxy260625",
      "credits": 0.8,
      "reason": "余额不足（0.8 credits < 3）",
      "abandoned_at": 1782389410.456
    }
  ]
}
```

### 7.3 状态码定义

| status | 含义 | 是否有图片输出 |
|--------|------|----------------|
| `queued` | 排队中（未开始） | 否 |
| `running` | 任务进行中 | 否 |
| `success` | 成功完成 | 是（`image_paths` 非空） |
| `failed` | 失败（重试耗尽） | 否（`error` 字段有原因） |
| `timeout` | 超时（300s 未完成） | 否 |

## 8. 错误处理与自动恢复

### 8.1 Session 过期自动恢复

```python
# 检测到 {"error": "请先登录"} 时
if is_auth_error(response.get("error", "")):
    # 1. 清除旧 token
    account.session_token = ""
    # 2. 重新登录
    if client.login():
        # 3. 重试原请求（每轮最多 1 次，避免死循环）
        return retry_original_request()
```

### 8.2 额度耗尽自动换号

```python
# 检测到 "insufficient_quota" 或 "额度不足" 或 "余额不足" 时
if is_quota_error(err):
    # 1. 标记当前账号为已耗尽
    pool.mark_exhausted(acc.username)
    # 2. 不增加重试计数
    # 3. 选下一个账号继续
    continue
```

### 8.3 模型失败自动回退

```python
# 当模型非 gpt-image-2 且重试耗尽时
if model != "gpt-image-2" and config["auto_fallback_gpt2"]:
    print(f"回退到 gpt-image-2 重试")
    model = "gpt-image-2"
    retry = 0
    continue
```

### 8.4 轮询连续错误

```python
# 连续 5 次轮询失败（网络/服务问题）则放弃
consecutive_errors = 0
# ... 每次错误 +1，成功归零
if consecutive_errors >= 5:
    return None  # 放弃，标记为 timeout 或 failed
```

### 8.5 登录失败处理

- 第 1 次失败：跳过该账号，继续其他账号
- 连续 2 次失败：标记为废弃（疑似密码错误或账号被封）
- 上游返回"用户名或密码错误"：直接标记废弃，不再重试

## 9. 性能与配额

### 9.1 并发计算

```
总并发 = 可用账号数 × 3
```

例：10 个账号 × 3 并发 = 30 个任务同时运行。

### 9.2 配额估算

每个新账号注册赠送 ¥1 = 10 张 gpt-image-2 standard 额度。10 个账号约可生成 100 张图。

| 模型 | 单账号可出图数 | 10 账号可出图数 |
|------|----------------|-----------------|
| gpt-image-2 (standard) | 10 | 100 |
| gpt-image-2 (high) | ~3 | ~30 |
| gpt-image-2 (ultra) | 0.33 | ~3 |
| grok-imagine-image | 25 | 250 |
| grok-imagine-image-lite | 50 | 500 |

### 9.3 速率限制

- 单账号并发上限：3（上游硬限制）
- 任务超时：300 秒（上游 hard limit）
- 轮询间隔建议：3 秒（避免触发频率限制）
- 登录失败冷却：5 分钟（避免触发账号锁定）

## 10. 注意事项

1. **必须经 worker 代理**：直连 `grok.17nas.com` 会被 Cloudflare 返回 403 challenge 页面，无法绕过
2. **签到功能已下线**：上游 `/account/checkin` 接口已失效，新额度只能靠注册赠送或充值
3. **任务按账号隔离**：A 账号提交的任务，B 账号无法查询。Session 过期重新登录后仍属同一账号，可继续查询
4. **图片 URL 需代理下载**：上游返回的图片 URL 直连会 401，必须通过 `/api/media-proxy?url=...&token=...` 下载
5. **base64 数据临时性**：上游返回的 base64 图片数据较大（单张 1-3MB），不适合在内存中长期保存，建议立即写入磁盘
6. **失败任务自动退款**：除"内容违规"外的失败任务，上游会自动退还 credits（可在 task.quota.refunded 字段确认）
7. **图片尺寸严格匹配**：上游会校验返回尺寸是否与请求一致，不一致会标记失败并退款。请使用 `calc_gpt_image_2_size()` 等工具计算合法尺寸
8. **不要频繁重新登录**：每次登录都会触发上游的 IP 频率限制逻辑，建议登录后缓存 token 并在过期时才重新登录

## 11. 调试与日志

### 11.1 启用详细日志

```python
import logging
logging.basicConfig(level=logging.DEBUG)
# 或针对 requests 库
import http.client
http.client.HTTPConnection.debuglevel = 1
```

### 11.2 常见错误诊断

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| `请先登录` | Session token 过期或无效 | 自动重新登录（skill 已内置） |
| `账户余额不足` | 账号 credits 用完 | 自动换号（skill 已内置） |
| `接口不存在` | 调用了已下线的接口（如 checkin） | 不要使用该接口 |
| `上游图片接口返回失败` | 上游服务异常 | 重试或换号 |
| `上游 1K 图片返回尺寸 1024×1536，不符合请求档位` | 请求尺寸与模型/比例不匹配 | 使用 `calc_gpt_image_2_size()` 计算合法尺寸 |
| `临时下架` / `暂不开放` | 视频模型等已下线 | 切换其他模型 |
| `content_policy` / `safety` | 内容违反政策 | 修改提示词 |
| `rate_limit` | 请求频率超限 | 降低并发或增加间隔 |

### 11.3 合法尺寸速查表

**gpt-image-2 各档位合法尺寸**：

| 比例 | standard (1.5K) | high (2.5K) | ultra (4K) |
|------|-----------------|-------------|------------|
| 1:1 | 1024×1024 | 2048×2048 | 2816×2816 |
| 16:9 | 1536×864 | 2560×1440 | 3840×2160 |
| 9:16 | 864×1536 | 1440×2560 | 2160×3840 |
| 3:2 | 1536×1024 | 2560×1707 | 3840×2560 |
| 2:3 | 1024×1536 | 1707×2560 | 2560×3840 |
| 4:3 | 1536×1152 | 2560×1920 | 3840×2880 |
| 3:4 | 1152×1536 | 1920×2560 | 2880×3840 |

**Grok 系列（除 lite）固定尺寸**：

| 比例 | 尺寸 |
|------|------|
| 1:1 | 1024×1024 |
| 16:9 / 2:1 / 21:9 | 1280×720 |
| 9:16 / 1:2 / 9:21 | 720×1280 |
| 3:2 / 4:3 / 5:4 | 1792×1024 |
| 2:3 / 3:4 / 4:5 | 1024×1792 |

**Grok-Lite**：固定 784×1168（仅支持 2:3）

## 12. 版本历史

### v26 (2026-06-25) - 当前版本

- 首次访问自动注册账号：检测到无账号时自动注册新账号并刷新额度，无需手动操作
- 恢复账号后自动刷新额度：登录已有账号后调用 refreshAllQuota 检测余额，余额不足的自动移入废弃池
- 无可用账号时自动注册：如果所有账号余额不足，自动注册新账号补充
- 修复 registerAccount 直接 fetch 上游导致页面跳转到 grok.17nas.com 的问题（移除直接 fetch，始终走 worker 代理）
- 移除注册失败时的 window.open 跳转（避免打开 grok.17nas.com 造成体验混乱）
- toast 通知移至右下角：避免遮挡右上角设置按钮，新通知从下往上叠加（flex-direction:column-reverse）

### v25 (2026-06-25)

- 适配上游计费模型变更：签到下线后账号变为一次性即抛型
- 新增 v25 计费模型：`get_credits_per_image()`、`credits_to_image_count()`、`can_generate_at_least_one()`
- 账号选择逻辑改用 `can_generate_at_least_one()` 替代 `credits > 0`
- 新增 `AccountPool.auto_cleanup_insufficient()`：登录后自动清理余额不足账号
- 新增 `AccountPool.mark_exhausted(username, reason)`：余额不足时移入废弃池并记录原因
- 新增 `AccountPool.total_image_count()` 和 `max_concurrency()`：基于可生成图片数计算
- manifest.json 改为对象结构，增加 `summary` 和 `abandoned_accounts` 字段
- 命令行新增 `--no-auto-cleanup` 参数：禁用自动清理
- 完整 Python 参考实现（约 760 行）
- 基于 v26 worker（2135 行）

### v1 (2026-06-25)

- 初版 skill 定义
- 基于已部署的 worker v24 实现
- 支持账号池批量登录、并发出图、自动重试、自动换号、自动回退
- 完整 Python 参考实现（约 400 行）
- 支持 .txt / .json 两种提示词格式
- 输出 manifest.json 任务清单

## 13. 相关链接

- Worker 在线地址：<https://ai-image.lishuhang.workers.dev>
- 上游网站：<https://grok.17nas.com>
- Worker 源码：`worker_v26.js`（v26，2135 行）
- Skill 规范：`v26-ai-image-skill.md`（本文档）
- Skill 实现：`ai_image_skill_v26.py`（v26，约 760 行）
