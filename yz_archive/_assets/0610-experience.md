# Agent-1 爬取实战经验：如何与微信 CAPTCHA 反复博弈

> 日期: 2026-06-10
> 作者: Agent-1（AI Agent）
> 目标: 抓取微信公众号「娱乐资本论」全部 2360 篇待爬文章中的 590 篇
> 作为 prompts.md 的补充说明，记录 prompt 中未涵盖的实战细节

---

## 一、起点：从零到 Agent-1

当我作为 Agent-1 启动时，已有 1331 篇文章被前一轮爬取完成（存储在 `1-1385.zip` 中），剩余 2360 篇需要由 4 个 Agent 并行完成。我的任务是其中序号 1-590 的部分。

任务清单已整理为 `agent_1_tasks.csv`，每行包含序号、文章标题和 URL。prompts.md 中给出了清晰的技术栈（Patchright + BeautifulSoup + markdownify）和反爬策略。但实际执行中，prompt 中简略提到的"CAPTCHA 约 60-70% 成功率，重试即可"远不能覆盖真正遇到的问题。以下是我在实战中逐步摸索出的完整经验。

---

## 二、微信 CAPTCHA 机制深度解析

### 2.1 微信反爬的三个层级

微信公众平台的反爬并非单一的验证码拦截，而是一个多层级、自适应的防御体系：

**第一层：浏览器指纹检测。** 微信服务器会检查来访请求的 User-Agent、viewport、设备特征等。直接用 `curl` 或标准 Playwright 访问时，微信会返回一个"环境异常"页面（HTML 中包含"验证"和"环境异常"关键字），而不是文章内容。这一层可以通过伪装微信内置浏览器 UA 来绕过。

**第二层：IP 级速率限制。** 在短时间内从同一 IP 请求过多文章，微信会临时封禁该 IP。封禁的表现是：即使 UA 正确，所有请求都返回 CAPTCHA 页面。封禁时长约为 10-30 分钟，且存在累积效应——被封禁次数越多，恢复所需时间越长。

**第三层：行为检测。** 微信可能检测请求模式（如固定间隔、无鼠标移动、无滚动行为等）来判断是否为自动化工具。这一层的存在尚未完全确认，但根据经验，随机化等待时间和定期重启浏览器确实有助于延长可用窗口。

### 2.2 CAPTCHA 触发的量化规律

通过多轮抓取，我总结了以下触发规律：

| 操作 | 大约触发阈值 |
|------|-------------|
| 连续抓取不暂停 | 约 20-30 篇后触发 |
| 每篇间隔 5 秒 | 约 30-40 篇后触发 |
| 每篇间隔 15 秒 | 约 40-60 篇后触发 |
| 每 3 篇暂停 2-5 分钟 | 约 50-80 篇后触发 |
| 每批 20 篇后重启浏览器 | 有助于延长窗口期 |

触发 CAPTCHA 后，IP 进入冷却期。第一次冷却约 10-20 分钟，之后每次触发冷却时间递增，最长可达 30 分钟以上。

### 2.3 "窗口期"现象

最重要的发现是：**CAPTCHA 封禁不是永久的，存在周期性的"窗口期"。** 在窗口期内，Patchright 可以正常访问文章，绕过验证码。窗口期的特征：

- 每次窗口期可持续抓取 5-30 篇文章不等
- 窗口期结束后 IP 再次被封禁
- 等待 10-30 分钟后窗口期会重新出现
- 窗口期的长度似乎与之前的抓取频率有关——越保守，窗口越长

---

## 三、技术方案的迭代演化

### 3.1 第一版：纯 HTTP 请求（batch_fetch_http.py）

最初我尝试不用浏览器，直接用 `urllib` 发送 HTTP 请求。设置了轮换 UA 列表（Android 微信 UA、iPhone 微信 UA 等），加上 CAPTCHA 检测和自动冷却逻辑。

**结果：失败。** 微信的反爬不仅看 UA，还会检查请求头中的其他特征（如 Accept、Referer 等），更重要的是，微信文章页面的正文内容 `#js_content` 需要 JavaScript 渲染后才能显示。纯 HTTP 请求拿到的 HTML 虽然包含了 JS 变量，但正文区域是空的。

**教训：** 微信文章页面依赖 JavaScript 渲染，必须使用真实浏览器。

### 3.2 第二版：curl 快速重试（curl_fetch.py）

接着尝试了用 `curl` 快速重试的策略——对每个 URL 连续请求 10 次，期望其中某次能绕过 CAPTCHA。设置最小内容大小阈值（100KB），过滤掉 CAPTCHA 页面和空页面。

**结果：部分成功但效率极低。** curl 虽然快，但无法执行 JavaScript，正文内容同样无法渲染。即便偶尔拿到完整 HTML，也是概率性的，不可靠。

**教训：** 快速重试不是解决 CAPTCHA 的正确方法，需要真正能执行 JS 的浏览器。

### 3.3 第三版：Patchright + 智能窗口检测（smart_fetch_v2.py）

这一版引入了两个关键创新：

1. **双模式检测**：先用 `urllib` 快速检测 CAPTCHA 状态（用已知 URL 探测），如果返回的 HTML 包含 `js_content` 且不含"环境异常"，说明窗口期开启，再用 Patchright 批量抓取。
2. **等待循环**：CAPTCHA 活跃时自动进入等待循环，每 3 分钟检测一次，逐渐增加等待时间（每次乘以 1.3，上限 10 分钟）。

**结果：可行但不够稳定。** urllib 的检测结果和 Patchright 的实际访问结果有时不一致——urllib 可能检测到窗口期已开，但 Patchright 访问时仍然遇到 CAPTCHA。这是因为微信可能对不同类型的请求（有无 Cookie、Session 状态等）有不同的判定。

**教训：** 检测和实际抓取应使用同一浏览器实例，避免状态不一致。

### 3.4 第四版：持续运行器（forever_fetch.py）

这一版设计为一个无限循环的持续抓取器，内置心跳线程保持沙箱活跃。核心逻辑：

- 每轮最多抓取 20 篇，遇到 CAPTCHA 就等待 5 分钟后重试
- 等待时间递增（每次 CAPTCHA 后冷却时间 ×1.3，上限 15 分钟）
- 心跳线程每 15 秒写一次 `heartbeat.txt`

**结果：基本可用，但后台进程不稳定。** 使用 `nohup` 或 `setsid` 运行时，进程在 CAPTCHA 等待期间会静默退出，原因不明。可能是沙箱环境的超时机制杀掉了长时间无输出的进程。

**教训：** 不能依赖后台进程。必须在前台运行，或使用心跳机制保持活跃。

### 3.5 第五版：单批快速抓取（quick_fetch.py）

放弃了持续运行的设计，改为每次只抓 20 篇的短批次模式。配合 subagent 调度：每次调用 subagent 运行 quick_fetch.py，8 分钟超时，subagent 结束后检查进度，决定是否需要再跑一批。

**结果：可行，成为主力方案。** 短批次模式避免了进程被杀的问题，subagent 的调度提供了额外的容错能力。CAPTCHA 触发后由主 agent 决定等待时间和重试策略。

### 3.6 第六版：慢速抓取（slow_fetch.py）

作为 quick_fetch.py 的保守替代方案，每篇文章之间等 15 秒，每批最多 10 篇。期望通过更低的请求频率避免触发 CAPTCHA。

**结果：有微弱效果但性价比低。** 15 秒间隔确实比 5 秒更不容易触发 CAPTCHA，但整体吞吐量下降了 3 倍。在时间有限的情况下，快速抓取 + CAPTCHA 冷却的组合策略更高效。

### 3.7 最终版：Agent-1 专用脚本（agent1_fetch_v2.py）

综合了之前所有版本的经验，为 Agent-1 的 590 篇任务定制。关键设计：

- **断点续抓**：`progress_agent_1.json` 记录每个 URL 的完成状态，脚本重启后自动跳过已完成文章
- **自适应重试**：每篇文章最多重试 5 次，重试间隔递增
- **浏览器生命周期管理**：每 20 篇重启浏览器，连续 3 次失败也重启，`pkill -9 -f chromium` 清理僵尸进程
- **定期备份**：每 5 篇保存进度，每 100 篇打包上传 GitHub
- **中文日期解析**：支持微信多种日期格式（`2023年5月10日 15:04`、`2023-05-10`、Unix 时间戳等）

---

## 四、关键技术细节

### 4.1 Patchright vs Playwright

Patchright 是 Playwright 的反检测分支，核心区别在于它修改了 Chromium 的指纹特征，使得自动化浏览器更难被检测。在实际使用中：

- **Patchright 可以非确定性地绕过微信 CAPTCHA。** 同样的代码，有时能直接通过 CAPTCHA，有时会被拦截。成功率大约 60-70%，与 prompt 中提到的一致。
- **安装方式不同**：`pip install patchright`，然后 `python3 -m patchright install chromium` 安装专用 Chromium。
- **API 完全兼容 Playwright**：`from patchright.async_api import async_playwright` 或 `from patchright.sync_api import sync_playwright`，其余用法与 Playwright 一致。

### 4.2 UA 伪装的细节

微信文章页面针对微信内置浏览器有特殊处理。以下 UA 被验证可用：

```
Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.51.2702(0x28003358) NetType/WIFI Language/zh_CN
```

关键要素：
- **`MicroMessenger/8.0.51.2702`**：这是微信内置浏览器的标识，必须包含
- **`Mobile Safari/537.36`**：移动端标识，配合 `is_mobile=True` 和 `viewport={'width':375,'height':812}`
- **`(0x28003358)`**：微信版本号，不同版本号可能影响行为
- **`NetType/WIFI Language/zh_CN`**：网络和语言信息，有助于增强伪装

### 4.3 发布时间提取的陷阱

微信文章的发布时间存储方式多样，需要多层级提取：

1. **DOM 元素 `#publish_time`**：最可靠，但需要 JS 渲染后才能获取。格式多样：
   - `2023-05-10 15:04`（标准格式）
   - `2023年05月10日 15:04`（中文格式）
   - `1683299104`（Unix 时间戳）

2. **JS 变量 `publish_time`**：通过 `page.evaluate('typeof publish_time !== "undefined" ? publish_time : ""')` 获取

3. **JS 变量 `var ct`**：Unix 时间戳格式，需要 `datetime.fromtimestamp()` 转换

4. **HTML meta 标签**：`<meta property="article:published_time" content="...">`

5. **页面内嵌 JS**：`var publish_time = "2023-05-10 15:04:23"`

在 v2 脚本中，我实现了逐级回退的提取策略，确保即使主提取方式失败，也能通过备选方式获取日期。

### 4.4 标题提取的 Patchright Bug

Patchright 在获取 `page.title()` 时，有时会返回 `ref: <Node-...>` 这样的内部引用字符串，而不是实际的标题文本。这是 Patchright 反检测机制导致的副作用。

解决方案：
- 优先从 DOM 元素 `#activity-name` 或 `h1.rich_media_title` 获取标题
- 用正则 `re.sub(r'ref: <Node-', '', raw_title).rstrip('>')` 清理 Patchright 的引用字符串
- 以 CSV 中的标题作为最终 fallback

### 4.5 图片懒加载问题

微信文章使用 `data-src` 属性实现图片懒加载，实际图片 URL 存储在 `data-src` 中而非 `src`。需要在 HTML 转 Markdown 之前，将 `data-src` 的值复制到 `src`：

```python
html_content = re.sub(r'data-src="([^"]+)"', r'src="\1"', html_content)
```

或在 BeautifulSoup 中处理：
```python
for img in article.find_all('img'):
    ds = img.get('data-src', '')
    if ds and not img.get('src'):
        img['src'] = ds
```

两种方法都可用，正则方式更简单但不够精确，BeautifulSoup 方式更可靠。

---

## 五、CAPTCHA 绕过策略总结

### 5.1 最有效的策略组合

经过多轮迭代，以下策略组合被证明最有效：

1. **Patchright 反检测浏览器** + 微信 UA 伪装（必要条件）
2. **每 20 篇重启浏览器**（防止内存泄漏和指纹累积）
3. **连续 3 次失败后重启浏览器**（重置 Session 状态）
4. **pkill 清理僵尸 Chromium 进程**（防止资源耗尽）
5. **CAPTCHA 触发后等待 10-30 分钟**（利用窗口期）
6. **每篇文章间随机等待 1-4 秒**（避免固定间隔模式）
7. **前台运行，避免后台进程被杀**

### 5.2 无效或低效的策略

- **纯 HTTP 请求**（curl/urllib）：无法执行 JS，正文不渲染
- **UA 轮换**：微信检测的主要不是 UA 本身，而是浏览器指纹
- **超长等待间隔（>30 秒/篇）**：虽然能减少 CAPTCHA 触发，但吞吐量过低
- **同时运行多个 Chromium 实例**：会加速触发 IP 封禁
- **web-reader skill（z-ai page_reader）**：也被微信拦截，无法绕过 CAPTCHA

### 5.3 CAPTCHA 窗口期利用流程

```
开始
  ↓
启动 Patchright 浏览器（微信 UA + 移动端 viewport）
  ↓
循环抓取文章（每篇间隔 1-4 秒随机）
  ↓
CAPTCHA 触发？─── 否 ───→ 继续抓取
  │
  是
  ↓
保存进度 + 关闭浏览器 + pkill chromium
  ↓
等待 10-30 分钟
  ↓
重新启动浏览器 → 继续抓取
```

---

## 六、工程实践经验

### 6.1 进度管理

断点续抓是最关键的功能。590 篇文章不可能一次完成，每次 CAPTCHA 封禁或进程崩溃都需要能够从断点恢复。

`progress_agent_1.json` 的设计：
```json
{
  "completed": {
    "https://mp.weixin.qq.com/s/xxxxx": {
      "title": "文章标题",
      "date": "20230510",
      "file": "20230510-文章标题.md"
    }
  },
  "failed": {
    "https://mp.weixin.qq.com/s/yyyyy": {
      "error": "Failed after max retries",
      "title": "失败文章标题"
    }
  },
  "stats": {
    "start_time": "2026-06-09T...",
    "last_update": "2026-06-10T...",
    "total_fetched": 100
  }
}
```

关键设计决策：
- **以 URL 为 key**（而非序号），因为同一篇文章的序号在不同 CSV 中可能不同
- **每 5 篇自动保存**，避免崩溃丢失太多进度
- **使用临时文件 + atomic rename** 保存进度，防止写入过程中断导致文件损坏

### 6.2 GitHub 备份策略

GitHub API 上传有大小限制（单文件 100MB），因此采用打包策略：

- 每 100 篇文章打包为一个 zip（`batch_1_1.zip`, `batch_1_2.zip` 等）
- 使用 `zipfile.ZIP_DEFLATED` 压缩，每个 zip 约 100-300KB
- 上传成功后删除本地 md 文件，减少崩溃时的数据丢失风险
- 上传前先检查文件是否已存在（获取 sha），支持覆盖更新

**重要教训：GitHub Secret Scanning 会拒绝包含 token 的文件。** 我最初将 prompts.md 中包含明文 GitHub Token 上传时被拒绝，后来将 token 替换为占位符 `<你的GitHub Token，见聊天记录>` 才成功上传。

### 6.3 浏览器进程管理

Chromium 在 headless 模式下容易产生僵尸进程，特别是在脚本异常退出时。必须主动管理：

```python
# 每次重启前清理
os.system('pkill -9 -f chromium 2>/dev/null')
await asyncio.sleep(3)  # 等待进程完全退出
```

不清理的后果：
- 僵尸进程占用内存和 CPU，导致新浏览器实例启动失败
- 多个 Chromium 实例同时运行会加速触发 IP 封禁
- 达到系统进程上限后无法再启动新浏览器

### 6.4 文件名规范化

最终采用的文件名格式：`yyyymmdd-【文章标题】.md`

规范化规则：
- 日期取自 `publish_time`，统一为 `yyyymmdd` 格式
- 标题中非法字符（`/ \ ? % * : | " < >`）替换为 `_`
- 标题限制 80 字符，防止文件名过长
- 去除标题首尾的点和空格
- 同名文件追加数字后缀（`_1`, `_2` 等）

---

## 七、给其他 Agent 的建议

### 7.1 期望管理

- 590 篇文章不可能在 3-4 小时内完成，实际需要 12-24 小时（受 CAPTCHA 限制）
- 实际抓取速率约 1-2 篇/分钟（包含 CAPTCHA 等待时间后的平均速率）
- 每个 CAPTCHA 窗口期可抓取 5-30 篇，窗口间需要等待 10-30 分钟

### 7.2 脚本设计建议

1. **必须实现断点续抓**，progress 文件是最重要的安全网
2. **使用 sync API 而非 async API**（如果不需要并发），sync 更简单且不易出错
3. **每篇文章独立 try-catch**，不要让单篇失败导致整批中断
4. **前台运行脚本**，不要用 nohup/setsid 后台运行
5. **定期 pkill chromium**，保持进程干净
6. **保存进度时使用 atomic write**（先写临时文件，再 rename）

### 7.3 调试技巧

- **检测 CAPTCHA 的关键字**：`"验证"` + `"环境异常"` 同时出现
- **有效内容的判断**：`len(html_content) < 100` 或 `content_el is None` 说明页面未正常加载
- **Patchright 标题 Bug**：`page.title()` 可能返回 `ref: <Node-...>`，需正则清理
- **日志输出**：使用 `sys.stdout.flush()` 确保实时输出，配合 `python3 -u` 无缓冲模式

### 7.4 如果要重新开始

如果让我重新开始这个任务，我会：

1. **第一步就使用 Patchright sync API + 微信 UA**，不浪费时间去试 HTTP 请求
2. **设计为短批次模式**（每次 15-20 篇），而非持续运行
3. **从第一天就实现 progress 文件**，而不是抓了几十篇后才发现需要断点续抓
4. **更早发现 CAPTCHA 窗口期规律**，而不是在连续失败中摸索
5. **每 50 篇就打包上传一次**（而非 100 篇），更频繁地备份
6. **在 CAPTCHA 等待期间做有用的事**，比如整理已抓取的文章、更新进度文件等

---

## 八、脚本版本演进时间线

| 版本 | 文件名 | 核心策略 | 结果 |
|------|--------|---------|------|
| v1 | batch_fetch_http.py | 纯 HTTP 请求 + UA 轮换 | 失败：JS 不渲染 |
| v2 | curl_fetch.py | curl 快速重试 | 失败：同上 |
| v3 | smart_fetch.py/v2 | urllib 检测 + Patchright 抓取 | 部分成功：检测与实际不一致 |
| v4 | forever_fetch.py | 无限循环 + 心跳 | 后台进程不稳定 |
| v5 | quick_fetch.py | 短批次（20篇）+ subagent 调度 | 可行：成为主力方案 |
| v6 | slow_fetch.py | 15秒间隔保守抓取 | 可行但效率低 |
| v7 | agent1_fetch.py | Agent-1 专用 async 版 | 首版可用脚本 |
| v8 | agent1_fetch_v2.py | 修复日期解析 + CAPTCHA 后继续提取 | 最终版本 |

---

## 九、附录：CAPTCHA 检测代码片段

### 用 urllib 快速检测（适用于 smart_fetch 系列脚本）

```python
def check_captcha_status():
    """用urllib快速检测CAPTCHA状态"""
    test_url = 'https://mp.weixin.qq.com/s/6nS50DTKVPr5LXYWCPjG_A'
    try:
        req = urllib.request.Request(test_url)
        req.add_header('User-Agent', UA)
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode('utf-8')
        has_captcha = '验证' in content and '环境异常' in content
        has_content = 'js_content' in content
        if has_content and not has_captcha:
            return True  # 可以访问
    except:
        pass
    return False  # CAPTCHA 活跃
```

### 用 Patchright 检测（更准确，但需要启动浏览器）

```python
# 在页面加载后检测
content = page.content()
if '环境异常' in content:
    captcha_hit = True
    break
if len(content) < 2000:
    fails += 1
    if fails >= 3:
        break
    continue
```

### CAPTCHA 冷却等待（递增策略）

```python
cooldown = 300  # 初始5分钟
while True:
    # ... 尝试抓取 ...
    if captcha_hit:
        log(f"CAPTCHA等待{cooldown}秒...")
        time.sleep(cooldown)
        cooldown = min(int(cooldown * 1.3), 900)  # 递增，上限15分钟
    else:
        cooldown = 300  # 重置为5分钟
```
