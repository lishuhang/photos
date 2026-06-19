#!/usr/bin/env python3
"""
Fetch WeChat article publish times and update GitHub repo files.

This script runs inside a GitHub Actions workflow. It:
1. Reads pending_files.json (list of files needing update)
2. For each file, fetches the WeChat article URL
3. Extracts the publish_time from the HTML
4. Builds new filename (YYYYMMDD-{title}.md) and updated content
5. Uses Git Data API to commit all changes atomically
6. Writes a results JSON for inspection

Usage:
    python fetch_publish_times.py

Required env vars:
    GITHUB_TOKEN: GitHub API token
    GITHUB_REPOSITORY: owner/repo (e.g. lishuhang/photos)
    INPUT_FILE: path to pending_files.json
    RESULTS_FILE: path to write results JSON
"""
import os
import re
import json
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta


# WeChat article HTML patterns
PUBLISH_TIME_PATTERNS = [
    # <em id="publish_time" class="rich_media_meta rich_media_meta_text">2023年3月30日 23:41</em>
    re.compile(r'<em[^>]*id="publish_time"[^>]*>([^<]+)</em>'),
    # Fallback: var ct = "1687156011"
    re.compile(r'var\s+ct\s*=\s*["\'](\d+)["\']'),
    # Fallback: window.ct = "1687156011"
    re.compile(r'window\.ct\s*=\s*["\'](\d+)["\']'),
    # Fallback: ct = "1687156011"
    re.compile(r'\bct\s*=\s*["\'](\d{9,11})["\']'),
    # Fallback: "publish_time":"2023-03-30 23:41"
    re.compile(r'"publish_time"\s*:\s*"([^"]+)"'),
    # Fallback: <meta property="og:article:published_time" content="2023-03-30T23:41:00+08:00">
    re.compile(r'<meta[^>]*property="og:article:published_time"[^>]*content="([^"]+)"'),
    # Fallback: <meta name="publish_time" content="2023-03-30 23:41">
    re.compile(r'<meta[^>]*name="publish_time"[^>]*content="([^"]+)"'),
    # Fallback: createTime = '1687156011'
    re.compile(r'createTime\s*=\s*["\'](\d{9,11})["\']'),
    # Fallback: <time datetime="2023-03-30T23:41:00+08:00">
    re.compile(r'<time[^>]*datetime="([^"]+)"'),
    # Fallback: 'create_time'=1687156011
    re.compile(r"create_time['\"]?\s*[:=]\s*['\"]?(\d{9,11})['\"]?"),
    # Fallback: 'update_time'=1687156011
    re.compile(r"update_time['\"]?\s*[:=]\s*['\"]?(\d{9,11})['\"]?"),
]

# Additional regex for finding any date-like pattern in script tags as last resort
DATE_IN_SCRIPT_PATTERN = re.compile(r'"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})')
CT_IN_ANY_CONTEXT = re.compile(r'\bct\s*=\s*["\'](\d{9,11})["\']')


def fetch_url(url, timeout=30):
    """Fetch URL with browser-like headers."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return resp.read().decode('utf-8', errors='ignore'), resp.status
    except urllib.error.HTTPError as e:
        return e.read().decode('utf-8', errors='ignore') if e.fp else '', e.code
    except Exception as e:
        return '', 0


def parse_publish_time(html):
    """Extract publish_time from WeChat article HTML.
    Returns (date_str_iso, original_text, source) tuple.
    date_str_iso: YYYY-MM-DD format, or None if not found
    original_text: the raw text from the HTML
    source: which pattern matched
    """
    # Check for verify page
    if '环境异常' in html or 'wappoc_appmsgcaptcha' in html:
        return None, 'CAPTCHA_BLOCKED', 'captcha'

    # Check for deleted/removed article pages
    if len(html) < 5000 and ('已删除' in html or '该内容已被发布者删除' in html or 'temporarily unavailable' in html.lower()):
        return None, 'ARTICLE_DELETED', 'deleted'

    for i, pattern in enumerate(PUBLISH_TIME_PATTERNS):
        m = pattern.search(html)
        if not m:
            continue
        raw = m.group(1).strip()
        if i == 0:
            # Chinese format: "2023年3月30日 23:41"
            m2 = re.match(r'(\d{4})年(\d{1,2})月(\d{1,2})日', raw)
            if m2:
                y, mo, d = m2.group(1), int(m2.group(2)), int(m2.group(3))
                return f"{y}-{mo:02d}-{d:02d}", raw, 'em_publish_time'
        elif i in (1, 2, 3, 7, 9, 10):
            # Unix timestamp patterns
            try:
                ts = int(raw)
                if 1000000000 < ts < 2000000000:  # sanity check
                    # WeChat ct is in Beijing time
                    dt = datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=8)))
                    return dt.strftime('%Y-%m-%d'), raw, f'ts_pattern_{i}'
            except ValueError:
                pass
        elif i == 4:
            # JSON ISO format
            m2 = re.match(r'(\d{4})-(\d{1,2})-(\d{1,2})', raw)
            if m2:
                y, mo, d = m2.group(1), int(m2.group(2)), int(m2.group(3))
                return f"{y}-{mo:02d}-{d:02d}", raw, 'json_publish_time'
        elif i in (5, 6):
            # Meta tag with ISO date
            m2 = re.match(r'(\d{4})-(\d{1,2})-(\d{1,2})', raw)
            if m2:
                y, mo, d = m2.group(1), int(m2.group(2)), int(m2.group(3))
                return f"{y}-{mo:02d}-{d:02d}", raw, 'meta_publish_time'
        elif i == 8:
            # <time datetime="...">
            m2 = re.match(r'(\d{4})-(\d{1,2})-(\d{1,2})', raw)
            if m2:
                y, mo, d = m2.group(1), int(m2.group(2)), int(m2.group(3))
                return f"{y}-{mo:02d}-{d:02d}", raw, 'time_tag'

    return None, '', 'not_found'


def build_new_filename(old_name, date_iso):
    """Build new filename with YYYYMMDD- prefix.
    Strips any existing prefix like '00000000-' or 'unknown-'.
    """
    # Strip .md extension
    base = old_name
    if base.endswith('.md'):
        base = base[:-3]

    # Strip known bad prefixes
    if base.startswith('00000000-'):
        base = base[len('00000000-'):]
    elif base.startswith('unknown-'):
        base = base[len('unknown-'):]

    # Convert YYYY-MM-DD to YYYYMMDD
    date_compact = date_iso.replace('-', '')
    return f"{date_compact}-{base}.md"


def build_new_content(content, date_iso):
    """Update the publish_time field in markdown content.
    Replaces `> 发布时间: <anything>` with `> 发布时间: YYYY-MM-DD`.
    If the line doesn't exist, returns content unchanged.
    """
    new_line = f"> 发布时间: {date_iso}"
    # Match the publish_time line (handles empty value, ref: <Node>, etc.)
    pattern = re.compile(r'^>\s*发布时间\s*:.*$', re.MULTILINE)
    if pattern.search(content):
        return pattern.sub(new_line, content, count=1)
    # If no publish_time line, try to add it after the 公众号 line
    insert_pattern = re.compile(r'(^>\s*公众号\s*:.*$)', re.MULTILINE)
    if insert_pattern.search(content):
        return insert_pattern.sub(r'\1\n' + new_line, content, count=1)
    # Fallback: return unchanged
    return content


def github_api(method, path, token, body=None, expect_json=True):
    """Make a GitHub API request."""
    url = f"https://api.github.com{path}"
    data = None
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        text = resp.read().decode('utf-8')
        status = resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode('utf-8') if e.fp else ''
        status = e.code
    except Exception as e:
        return 0, {'error': str(e)}

    if expect_json and text:
        try:
            return status, json.loads(text)
        except json.JSONDecodeError:
            return status, {'_text': text}
    return status, {'_text': text}


def main():
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('INPUT_GITHUB_TOKEN')
    repo = os.environ.get('GITHUB_REPOSITORY') or 'lishuhang/photos'
    input_file = os.environ.get('INPUT_FILE', 'pending_files.json')
    results_file = os.environ.get('RESULTS_FILE', 'results.json')
    branch = os.environ.get('BRANCH', 'main')
    max_per_run = int(os.environ.get('MAX_PER_RUN', '0')) or None

    if not token:
        print("ERROR: GITHUB_TOKEN not set")
        return 1

    with open(input_file, encoding='utf-8') as f:
        items = json.load(f)

    if max_per_run:
        items = items[:max_per_run]

    print(f"Processing {len(items)} files in repo {repo} on branch {branch}")

    results = []
    success_count = 0
    fail_count = 0

    for idx, item in enumerate(items):
        path = item['path']
        old_name = item['name']
        wechat_url = item['url']
        result = {
            'idx': idx,
            'path': path,
            'old_name': old_name,
            'url': wechat_url,
        }

        if not wechat_url:
            result['status'] = 'no_url'
            results.append(result)
            fail_count += 1
            print(f"[{idx+1}/{len(items)}] SKIP (no URL): {old_name[:60]}")
            continue

        # Fetch WeChat article (retry up to 3 times on transient failures)
        html, status = '', 0
        for attempt in range(3):
            html, status = fetch_url(wechat_url, timeout=45)
            if html and status == 200:
                break
            print(f"  retry {attempt+1}/3 (status={status}, len={len(html)})")
            time.sleep(2 * (attempt + 1))
        
        if not html:
            result['status'] = 'fetch_failed'
            result['http_status'] = status
            results.append(result)
            fail_count += 1
            print(f"[{idx+1}/{len(items)}] FAIL (fetch): {old_name[:60]}")
            continue

        date_iso, raw_text, source = parse_publish_time(html)
        result['raw_publish_time'] = raw_text
        result['source'] = source
        result['html_length'] = len(html)

        if not date_iso:
            result['status'] = 'parse_failed'
            # Save first 3000 chars of HTML for debugging
            result['html_snippet'] = html[:3000]
            results.append(result)
            fail_count += 1
            print(f"[{idx+1}/{len(items)}] FAIL (parse): {old_name[:60]} | source={source} | html_len={len(html)}")
            continue

        result['date_iso'] = date_iso
        new_name = build_new_filename(old_name, date_iso)
        new_path = f"yz_archive/1-2275/{new_name}"
        result['new_name'] = new_name
        result['new_path'] = new_path

        # Skip if no change needed
        if new_name == old_name:
            # Still need to update content publish_time
            pass

        # Build new content
        old_content = item.get('content', '')
        if not old_content:
            # Re-fetch from raw
            raw_url = f"https://raw.githubusercontent.com/{repo}/{branch}/{urllib.parse.quote(path)}"
            old_content, _ = fetch_url(raw_url)
        new_content = build_new_content(old_content, date_iso)
        result['content_changed'] = (new_content != old_content)

        result['status'] = 'ready'
        result['new_content'] = new_content
        result['old_content'] = old_content
        results.append(result)
        success_count += 1
        print(f"[{idx+1}/{len(items)}] OK: {old_name[:40]} -> {new_name[:50]} | {date_iso} ({source})")

        # Be polite to WeChat
        time.sleep(0.5)

    print(f"\nFetch phase done: {success_count} ready, {fail_count} failed")

    # Save intermediate results
    with open(results_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"Saved intermediate results to {results_file}")

    # Commit changes via Git Data API
    ready_items = [r for r in results if r.get('status') == 'ready']
    if not ready_items:
        print("No changes to commit")
        return 0

    print(f"\nCommitting {len(ready_items)} changes via Git Data API...")

    # Get the latest commit SHA on the branch
    status, ref = github_api('GET', f'/repos/{repo}/git/refs/heads/{branch}', token)
    if status != 200:
        print(f"Failed to get branch ref: {status} {ref}")
        return 1
    parent_sha = ref['object']['sha']
    print(f"Parent commit: {parent_sha}")

    # Get the parent commit's tree SHA
    status, parent_commit = github_api('GET', f'/repos/{repo}/git/commits/{parent_sha}', token)
    if status != 200:
        print(f"Failed to get parent commit: {status} {parent_commit}")
        return 1
    base_tree = parent_commit['tree']['sha']
    print(f"Base tree: {base_tree}")

    # Build tree modifications
    # Each entry: {path, mode, type, content} for new files
    # For deletions: {path, mode, type, sha: null} (use sha=null to delete)
    tree_items = []
    # Group by new_path to avoid duplicates
    seen_new_paths = set()
    for r in ready_items:
        # Skip if we somehow end up with a duplicate new_path
        if r['new_path'] in seen_new_paths:
            print(f"WARNING: duplicate new_path {r['new_path']}, skipping rename for {r['path']}")
            # Only update content in place
            tree_items.append({
                'path': r['path'],
                'mode': '100644',
                'type': 'blob',
                'content': r['new_content'],
            })
            continue
        seen_new_paths.add(r['new_path'])

        # Delete old file (only if path differs from new_path)
        if r['path'] != r['new_path']:
            tree_items.append({
                'path': r['path'],
                'mode': '100644',
                'type': 'blob',
                'sha': None,  # null sha = deletion
            })
        # Add new file with updated content
        tree_items.append({
            'path': r['new_path'],
            'mode': '100644',
            'type': 'blob',
            'content': r['new_content'],
        })

    # Create new tree
    status, new_tree = github_api('POST', f'/repos/{repo}/git/trees', token, body={
        'base_tree': base_tree,
        'tree': tree_items,
    })
    if status not in (200, 201):
        print(f"Failed to create tree: {status} {new_tree}")
        return 1
    new_tree_sha = new_tree['sha']
    print(f"New tree: {new_tree_sha}")

    # Create commit
    status, new_commit = github_api('POST', f'/repos/{repo}/git/commits', token, body={
        'message': f'Update {len(ready_items)} files with correct publish times',
        'tree': new_tree_sha,
        'parents': [parent_sha],
    })
    if status not in (200, 201):
        print(f"Failed to create commit: {status} {new_commit}")
        return 1
    new_commit_sha = new_commit['sha']
    print(f"New commit: {new_commit_sha}")

    # Update ref
    status, updated_ref = github_api('PATCH', f'/repos/{repo}/git/refs/heads/{branch}', token, body={
        'sha': new_commit_sha,
    })
    if status != 200:
        print(f"Failed to update ref: {status} {updated_ref}")
        return 1
    print(f"Successfully updated {branch} to {new_commit_sha}")

    # Update results with commit info
    for r in results:
        r['commit_sha'] = new_commit_sha
    with open(results_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\nAll done. Results saved to {results_file}")
    return 0


if __name__ == '__main__':
    sys = __import__('sys')
    sys.exit(main())
