#!/usr/bin/env python3
"""微信公众号文章抓取脚本 - GitHub Actions 通用版（支持 agent_id 参数）。

在 GitHub Actions runner 上运行，利用 GitHub IP 绕过沙箱 IP 封禁。
直接 commit MD 文件到 repo，无需打包 zip。
"""
import csv, json, os, re, time, random, base64, urllib.request, urllib.parse, subprocess
from datetime import datetime, timezone, timedelta
from bs4 import BeautifulSoup
from markdownify import markdownify
from patchright.sync_api import sync_playwright

# 配置（通过环境变量传入）
AGENT_ID = int(os.environ.get("AGENT_ID", "1"))
REPO = os.environ.get("GITHUB_REPOSITORY", "lishuhang/photos")
TOKEN = os.environ.get("GITHUB_TOKEN")
BRANCH = os.environ.get("BRANCH", "main")
TARGET_DIR = os.environ.get("TARGET_DIR", "yz_archive/1-3694")

WORK_DIR = os.environ.get("WORK_DIR", f"/tmp/agent{AGENT_ID}_work")
CSV_PATH = os.environ.get("CSV_PATH", f"{WORK_DIR}/agent_{AGENT_ID}_tasks.csv")
PROGRESS_FILE = f"{WORK_DIR}/progress_agent_{AGENT_ID}.json"
LOG_FILE = f"{WORK_DIR}/crawl.log"

MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "21000"))  # ~5.8 hours

UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 "
      "MicroMessenger/8.0.51.2702(0x28003358) NetType/WIFI Language/zh_CN")

def log(msg):
    line = f"[{datetime.now().isoformat(timespec='seconds')}] [agent{AGENT_ID}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except: pass

def github_api(method, path, body=None):
    url = f"https://api.github.com{path}"
    headers = {"Authorization": f"token {TOKEN}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data: headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        text = resp.read().decode("utf-8")
        return resp.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8") if e.fp else ""
        return e.code, (json.loads(text) if text else {})

def commit_file(repo_path, content, commit_msg, retry=2):
    """直接 commit 文件到 repo。content 是字符串。返回 True/False。"""
    api_path = f"/repos/{REPO}/contents/{urllib.parse.quote(repo_path)}?ref={BRANCH}"
    for attempt in range(retry + 1):
        try:
            status, info = github_api("GET", api_path)
            sha = info.get("sha") if status == 200 else None
            content_b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
            body = {"message": commit_msg, "content": content_b64, "branch": BRANCH}
            if sha: body["sha"] = sha
            status, _ = github_api("PUT", f"/repos/{REPO}/contents/{urllib.parse.quote(repo_path)}", body=body)
            if status in (200, 201):
                return True
            # 409 = conflict (concurrent push), retry
            if status == 409 and attempt < retry:
                time.sleep(3)
                continue
            return False
        except Exception as e:
            if attempt < retry:
                time.sleep(3)
                continue
            log(f"  commit_file exception: {e}")
            return False
    return False

def load_progress():
    # 从本地读取
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except: pass
    # 从 repo 读取
    api_path = f"/repos/{REPO}/contents/{urllib.parse.quote(f'yz_archive/progress_agent_{AGENT_ID}.json')}?ref={BRANCH}"
    status, info = github_api("GET", api_path)
    if status == 200 and "content" in info:
        content = base64.b64decode(info["content"]).decode("utf-8")
        os.makedirs(WORK_DIR, exist_ok=True)
        with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
            f.write(content)
        return json.loads(content)
    return {"completed": {}, "failed": {},
            "stats": {"start_time": "", "last_update": "", "total_fetched": 0}}

def save_progress(progress):
    progress["stats"]["last_update"] = datetime.now().isoformat(timespec='seconds')
    os.makedirs(WORK_DIR, exist_ok=True)
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)
    os.rename(tmp, PROGRESS_FILE)
    # 同步到 repo（best-effort，失败不影响主流程）
    try:
        commit_file(f"yz_archive/progress_agent_{AGENT_ID}.json",
                    json.dumps(progress, ensure_ascii=False, indent=2),
                    f"agent{AGENT_ID} progress update ({len(progress['completed'])} done)")
    except Exception as e:
        log(f"  WARN: failed to commit progress: {e}")

def parse_date(page):
    try:
        pt = page.evaluate('document.querySelector("#publish_time")?.textContent?.trim() || ""')
        if pt:
            m = re.match(r'(\d{4})年(\d{1,2})月(\d{1,2})日', pt)
            if m: return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
            m = re.match(r'(\d{4})-(\d{1,2})-(\d{1,2})', pt)
            if m: return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    except: pass
    try:
        ct = page.evaluate('typeof ct !== "undefined" ? ct : ""')
        if ct and str(ct).isdigit():
            ts = int(ct)
            if 1000000000 < ts < 2000000000:
                return datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
    except: pass
    try:
        ct = page.evaluate('typeof window.ct !== "undefined" ? window.ct : ""')
        if ct and str(ct).isdigit():
            ts = int(ct)
            if 1000000000 < ts < 2000000000:
                return datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
    except: pass
    try:
        m = page.evaluate('document.querySelector(\'meta[property="og:article:published_time"]\')?.content || ""')
        if m:
            mm = re.match(r'(\d{4})-(\d{1,2})-(\d{1,2})', m)
            if mm: return f"{mm.group(1)}-{int(mm.group(2)):02d}-{int(mm.group(3)):02d}"
    except: pass
    return None

def extract_title(page, csv_title):
    try:
        t = page.evaluate('document.querySelector("#activity-name")?.textContent?.trim() || ""')
        if t:
            t = re.sub(r'ref: <Node.*', '', t).strip()
            if t: return t
    except: pass
    try:
        t = page.title()
        if t and 'ref: <Node' not in t: return t.strip()
    except: pass
    return csv_title

def sanitize_filename(title):
    title = re.sub(r'[/\\?%*:|"<>【】]', '_', title)
    title = title.strip(' .')
    title = re.sub(r'_+', '_', title)
    return title[:80]

def fetch_article(page, url, csv_title):
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        return None, f"GOTO_FAIL: {e}"
    page.wait_for_timeout(2000)
    try:
        page.wait_for_selector("#js_content", timeout=15000)
    except: pass
    html = page.content()
    if ("环境异常" in html and "验证" in html) or "wappoc_appmsgcaptcha" in html:
        return None, "CAPTCHA"
    title = extract_title(page, csv_title)
    date = parse_date(page)
    if not date: date = "0000-00-00"
    try:
        content_html = page.evaluate('document.querySelector("#js_content")?.outerHTML || ""')
    except:
        content_html = ""
    if not content_html or len(content_html) < 100:
        return None, "NO_CONTENT"
    content_html = re.sub(r'data-src="([^"]+)"', r'src="\1"', content_html)
    soup = BeautifulSoup(content_html, "html.parser")
    md_body = markdownify(str(soup), heading_style="ATX")
    full_md = (f"# {title}\n\n> 公众号: 娱乐资本论\n> 发布时间: {date}\n"
               f"> 原文链接: {url}\n\n---\n\n{md_body}\n")
    date_compact = date.replace("-", "")
    safe_title = sanitize_filename(title)
    filename = f"{date_compact}-{safe_title}.md"
    return {"filename": filename, "content": full_md, "title": title, "date": date}, None

def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    log("="*60)
    log(f"Agent-{AGENT_ID} GH Actions starting (MAX_SECONDS={MAX_SECONDS})")
    log(f"Repo: {REPO}, Branch: {BRANCH}, Target dir: {TARGET_DIR}")
    log("="*60)

    # 下载 CSV（如果本地不存在）
    if not os.path.exists(CSV_PATH):
        log("Downloading CSV from repo...")
        csv_repo_path = f"yz_archive/agent_{AGENT_ID}_tasks_0621.csv"
        api_path = f"/repos/{REPO}/contents/{urllib.parse.quote(csv_repo_path)}?ref={BRANCH}"
        status, info = github_api("GET", api_path)
        if status == 200 and "content" in info:
            csv_content = base64.b64decode(info["content"]).decode("utf-8")
            with open(CSV_PATH, "w", encoding="utf-8") as f:
                f.write(csv_content)
            log(f"Downloaded CSV: {len(csv_content)} bytes")
        else:
            log(f"FATAL: cannot download CSV from {csv_repo_path}: {status}")
            return 1

    with open(CSV_PATH, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        tasks = [(int(r["序号"]), r["文章标题"], r["URL"]) for r in reader]
    log(f"Loaded {len(tasks)} tasks")

    progress = load_progress()
    progress["stats"]["start_time"] = progress["stats"].get("start_time") or datetime.now().isoformat(timespec='seconds')
    log(f"Resumed: {len(progress['completed'])} completed, {len(progress['failed'])} failed")
    save_progress(progress)

    consecutive_fails = 0
    articles_since_restart = 0
    cooldown = 300
    captcha_count = 0
    start_time = time.time()
    should_exit = False
    commit_count = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA, viewport={"width": 375, "height": 812}, is_mobile=True)
        page = context.new_page()
        log("Browser launched")

        for seq, csv_title, url in tasks:
            elapsed = time.time() - start_time
            if elapsed >= MAX_SECONDS:
                log(f"Reached MAX_SECONDS={MAX_SECONDS} (elapsed {int(elapsed)}s), exiting")
                break
            if url in progress["completed"] or url in progress["failed"]:
                continue

            log(f"[{seq}/{len(tasks)}] {csv_title[:50]} | {url}")

            success = False
            for attempt in range(5):
                try:
                    result, err = fetch_article(page, url, csv_title)
                    if result:
                        repo_path = f"{TARGET_DIR}/{result['filename']}"
                        ok = commit_file(repo_path, result["content"],
                                        f"agent{AGENT_ID}: {result['filename']}")
                        if ok:
                            progress["completed"][url] = {
                                "title": result["title"],
                                "date": result["date"],
                                "file": result["filename"],
                            }
                            progress["stats"]["total_fetched"] = len(progress["completed"])
                            commit_count += 1
                            success = True
                            consecutive_fails = 0
                            cooldown = 300
                            log(f"  OK: {result['filename']} | {result['date']} (#{commit_count})")
                        else:
                            log(f"  FAIL to commit: {result['filename']}")
                            time.sleep(5)
                        break
                    elif err == "CAPTCHA":
                        captcha_count += 1
                        remaining = MAX_SECONDS - (time.time() - start_time)
                        if remaining < cooldown + 60:
                            log(f"  CAPTCHA but only {int(remaining)}s left, exiting")
                            should_exit = True
                            break
                        log(f"  CAPTCHA #{captcha_count}, cooldown {cooldown}s, {int(remaining)}s remaining")
                        try: context.close()
                        except: pass
                        slept = 0
                        while slept < cooldown:
                            time.sleep(min(30, cooldown - slept))
                            slept += 30
                            if time.time() - start_time >= MAX_SECONDS:
                                should_exit = True
                                break
                        if should_exit: break
                        cooldown = min(cooldown + 300, 1800)
                        context = browser.new_context(user_agent=UA, viewport={"width": 375, "height": 812}, is_mobile=True)
                        page = context.new_page()
                    else:
                        log(f"  FAIL attempt {attempt+1}/5: {err}")
                        time.sleep(3)
                except Exception as e:
                    log(f"  EXCEPTION attempt {attempt+1}/5: {e}")
                    time.sleep(3)

            if not success and not should_exit:
                progress["failed"][url] = {"error": "max retries exceeded", "title": csv_title}
                consecutive_fails += 1
                log(f"  GIVE UP (consecutive: {consecutive_fails})")
                if consecutive_fails >= 3:
                    log(f"  3 fails, restarting browser")
                    try: browser.close()
                    except: pass
                    subprocess.run(["pkill", "-9", "chromium"], stderr=subprocess.DEVNULL)
                    time.sleep(5)
                    browser = p.chromium.launch(headless=True)
                    context = browser.new_context(user_agent=UA, viewport={"width": 375, "height": 812}, is_mobile=True)
                    page = context.new_page()
                    consecutive_fails = 0
                    articles_since_restart = 0

            articles_since_restart += 1
            if articles_since_restart >= 20:
                log(f"  Periodic restart (20 articles)")
                try: browser.close()
                except: pass
                subprocess.run(["pkill", "-9", "chromium"], stderr=subprocess.DEVNULL)
                time.sleep(3)
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(user_agent=UA, viewport={"width": 375, "height": 812}, is_mobile=True)
                page = context.new_page()
                articles_since_restart = 0

            if len(progress["completed"]) % 5 == 0:
                save_progress(progress)

            if commit_count % 50 == 0 and commit_count > 0:
                save_progress(progress)
                log(f"  Milestone: {len(progress['completed'])} completed, {commit_count} committed this run")

            time.sleep(random.uniform(3, 7))

            if should_exit: break

        save_progress(progress)
        try: browser.close()
        except: pass
        subprocess.run(["pkill", "-9", "chromium"], stderr=subprocess.DEVNULL)

    log("="*60)
    log(f"DONE. Completed: {len(progress['completed'])}, Failed: {len(progress['failed'])}")
    log(f"Total commits this run: {commit_count}")
    log(f"Total CAPTCHA hits: {captcha_count}")
    log("="*60)

if __name__ == "__main__":
    main()
