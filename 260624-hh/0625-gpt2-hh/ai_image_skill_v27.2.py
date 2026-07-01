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


# ============== v25: 计费模型 ==============
# 上游仍用 imageCredits 字段（1 credit = ¥0.1），但签到下线后账号一次性即抛
# 各模型/档位单张所需 credits（来自上游 system 配置）
GPT2_TIER_CREDITS = {"standard": 3, "high": 8, "ultra": 30}
MODEL_CREDITS = {
    "grok-imagine-image-lite": 0.2,
    "grok-imagine-image": 0.4,
    "grok-imagine-image-edit": 0.4,
    "grok-imagine-image-pro": 1,
}


def get_credits_per_image(model: str, tier: str = "standard") -> float:
    """获取指定模型/档位下单张图片所需 credits"""
    if model == "gpt-image-2":
        return GPT2_TIER_CREDITS.get(tier or "standard", 3)
    if model in MODEL_CREDITS:
        return MODEL_CREDITS[model]
    return 3  # 默认按 gpt-image-2 standard


def credits_to_image_count(credits: float, model: str, tier: str = "standard") -> int:
    """将 credits 转换为可生成图片数（向下取整）"""
    if not credits or credits <= 0:
        return 0
    cost = get_credits_per_image(model, tier)
    if cost <= 0:
        return 0
    return int(credits // cost)


def can_generate_at_least_one(credits: float, model: str, tier: str = "standard") -> bool:
    """判断账号余额是否足以生成至少 1 张图"""
    return credits >= get_credits_per_image(model, tier)


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
    """v25: 账号池管理 - 支持自动废弃余额不足账号"""

    def __init__(self, accounts: list, config: dict):
        self.accounts = [Account(**a) for a in accounts]
        self.config = config
        self.exhausted = set()  # 已耗尽额度的用户名
        self.abandoned = []  # v25: 废弃账号列表（余额不足/登录失败）

    @property
    def model(self) -> str:
        return self.config["model"]

    @property
    def tier(self) -> str:
        return self.config.get("quality_tier", "standard")

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
        # v25: 登录后自动清理余额不足账号
        self.auto_cleanup_insufficient()

    def _login_one(self, idx: int):
        acc = self.accounts[idx]
        client = AIClient(acc, self.config)
        if client.login():
            img_count = credits_to_image_count(acc.credits, self.model, self.tier)
            print(f"  ✓ {acc.username} (credits={acc.credits}, 可生成 {img_count} 张)")
        else:
            print(f"  ✗ {acc.username} 登录失败")

    def select_account(self) -> Optional[Account]:
        """v25: 选择可生成图片数最多且未被耗尽的账号"""
        candidates = [
            a for a in self.accounts
            if a.session_token and not a.disabled
            and can_generate_at_least_one(a.credits, self.model, self.tier)
            and a.username not in self.exhausted
        ]
        if not candidates:
            return None
        # 按"可生成图片数"降序选择
        return max(candidates, key=lambda a: credits_to_image_count(a.credits, self.model, self.tier))

    def mark_exhausted(self, username: str, reason: str = "余额不足"):
        """v25: 标记账号为已耗尽，并自动移入废弃池"""
        self.exhausted.add(username)
        for i, a in enumerate(self.accounts):
            if a.username == username:
                a.credits = 0
                # 移入废弃池
                self.abandoned.append({
                    "username": a.username,
                    "password": a.password,
                    "credits": a.credits,
                    "reason": reason,
                    "abandoned_at": time.time(),
                })
                self.accounts.pop(i)
                print(f"[pool] {username} 已移入废弃池（{reason}）")
                break

    def auto_cleanup_insufficient(self):
        """v25: 自动清理余额不足的账号（无法生成 1 张 gpt-image-2 standard 的）"""
        # 使用 gpt-image-2 standard (3 credits) 作为最低阈值
        min_credits = get_credits_per_image("gpt-image-2", "standard")
        to_remove = []
        for i, a in enumerate(self.accounts):
            if a.disabled:
                continue
            if a.credits < min_credits:
                to_remove.append(i)

        # 倒序移除以避免索引错位
        for i in reversed(to_remove):
            a = self.accounts[i]
            self.abandoned.append({
                "username": a.username,
                "password": a.password,
                "credits": a.credits,
                "reason": f"余额不足（{a.credits} credits < {min_credits}）",
                "abandoned_at": time.time(),
            })
            self.exhausted.add(a.username)
            self.accounts.pop(i)
            print(f"[pool] {a.username} 余额仅 {a.credits}，自动移入废弃池")

        if to_remove:
            print(f"[pool] 自动清理 {len(to_remove)} 个余额不足账号，剩余 {len(self.accounts)} 个可用")

    def total_image_count(self) -> int:
        """v25: 计算所有可用账号的总可生成图片数"""
        return sum(
            credits_to_image_count(a.credits, self.model, self.tier)
            for a in self.accounts
            if a.session_token and not a.disabled
        )

    def max_concurrency(self) -> int:
        """v25: 按可生成至少 1 张图的账号数计算并发"""
        ok = [
            a for a in self.accounts
            if a.session_token and not a.disabled
            and can_generate_at_least_one(a.credits, self.model, self.tier)
        ]
        return len(ok) * self.config["concurrent_per_account"]


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
                    # 提交失败：检测额度不足 → v25 移入废弃池并换号（不增加 retry）
                    if is_quota_error(submit_err):
                        self.pool.mark_exhausted(acc.username, f"余额不足（{submit_err[:50]}）")
                        print(f"[gen] {acc.username} 余额不足，已移入废弃池，换号重试")
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
                        self.pool.mark_exhausted(acc.username, f"余额不足（{err[:50]}）")
                        print(f"[gen] {acc.username} 余额不足，已移入废弃池，换号重试")
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


def write_manifest(items: list, output_dir: Path, abandoned: list = None):
    """v25: manifest 增加废弃账号信息"""
    manifest = {
        "summary": {
            "total_prompts": len(items),
            "success": sum(1 for it in items if it.status == "success"),
            "failed": sum(1 for it in items if it.status == "failed"),
            "timeout": sum(1 for it in items if it.status == "timeout"),
        },
        "tasks": [],
        "abandoned_accounts": abandoned or [],
    }
    for it in items:
        d = asdict(it)
        d["duration_sec"] = round(it.completed_at - it.started_at, 2) if it.completed_at > it.started_at else 0
        manifest["tasks"].append(d)
    manifest_path = output_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"[manifest] 已写入 {manifest_path}")


# ============== 主入口 ==============
def main():
    parser = argparse.ArgumentParser(description="AI Image Generation Skill v25")
    parser.add_argument("--accounts", required=True, help="账号池 JSON 文件路径")
    parser.add_argument("--prompts", required=True, help="提示词文件（.txt 或 .json）")
    parser.add_argument("--output", default="/home/z/my-project/download/images",
                        help="图片输出目录（默认 /home/z/my-project/download/images）")
    parser.add_argument("--model", default=None, help="覆盖默认模型")
    parser.add_argument("--size", default=None, help="覆盖默认尺寸（如 1024x1024）")
    parser.add_argument("--ratio", default=None, help="覆盖默认比例（如 16:9）")
    parser.add_argument("--quality", default=None, choices=["standard", "high", "ultra"])
    parser.add_argument("--count", type=int, default=None, help="每条提示词生成几张")
    parser.add_argument("--no-auto-cleanup", action="store_true",
                        help="v25: 禁用登录后自动清理余额不足账号")
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

    print(f"=== AI Image Generation Skill v25 ===")
    print(f"账号数: {len(accounts)}")
    print(f"提示词数: {len(prompts)} (展开后 {len(expanded)} 任务)")
    print(f"配置: {config}")
    print(f"输出目录: {output_dir}")
    # v25: 显示单张成本和总可生成图片数预估
    cost = get_credits_per_image(config["model"], config.get("quality_tier", "standard"))
    print(f"单张成本: {cost} credits (模型={config['model']}, 档位={config.get('quality_tier', 'standard')})")
    print()

    # 2. 登录所有账号
    pool = AccountPool(accounts, config)
    pool.login_all()

    # v25: 登录后自动清理（可通过 --no-auto-cleanup 禁用）
    if not args.no_auto_cleanup:
        pool.auto_cleanup_insufficient()

    # v25: 显示账号池状态
    total_imgs = pool.total_image_count()
    max_c = pool.max_concurrency()
    print(f"[pool] 可用账号 {len(pool.accounts)} 个，总可生成 {total_imgs} 张图，最大并发 {max_c}")
    if pool.abandoned:
        print(f"[pool] 废弃账号 {len(pool.abandoned)} 个（余额不足）")
    print()

    # 3. 批量生成
    generator = BatchGenerator(pool, expanded, config, output_dir)
    generator.run()

    # 4. 输出清单
    write_manifest(expanded, output_dir, pool.abandoned)

    # 5. 汇总
    ok = sum(1 for p in expanded if p.status == "success")
    failed = sum(1 for p in expanded if p.status == "failed")
    timeout = sum(1 for p in expanded if p.status == "timeout")
    print()
    print(f"=== 完成 ===")
    print(f"成功: {ok}, 失败: {failed}, 超时: {timeout}")
    print(f"输出目录: {output_dir}")
    if pool.abandoned:
        print(f"废弃账号: {len(pool.abandoned)} 个（详见 manifest.json）")


if __name__ == "__main__":
    main()