// Cloudflare Worker - AI生图 Beta v1.0 (imagebeta-worker)
// v1.0: 多通道架构
//   - 新增顶部通道选择器（自动 / KeyDraw / 马良），可手动切换上游供应商
//   - '自动' 模式：记住上次使用的通道，硬失败时自动切换到另一通道继续同一任务
//     （参考图等附件一并传递；内容政策违规不切换，因换通道也会被拒）
//   - 后端 handleProxy / image-proxy / gift-key 全部按 X-Channel 头分发到对应上游
//   - 前端 apiFetch / apiFetchMultipart 自动附加 X-Channel 头与对应鉴权头
//     （keydraw=Bearer，maliang=Cookie: session=<token>）
//   - 账号池按通道独立维护：state.accountsByKeydraw / state.accountsByMaliang
//   - 旧 state 自动迁移：原有 state.accounts 视作 keydraw 池
// v0.7: 四项修复
//   (1) addToPromptLib 缺失 renderPromptLib() 调用，导致提示词入库后 UI 面板不刷新
//   (2) refreshModelAvailability 改为 no-op：keydraw 无 /account/quota 与 /proxy/videos 端点，每次页面加载都会产生两条 404 噪声
//   (3) showInvitePanel 友好降级：keydraw 共享 Gift Key 模式无邀请系统，原调用 /account/invite 会失败
//   (4) getChainInviteCode 短路返回 null：同上，避免 registerAccount 路径中的无效 API 调用
// v0.5: 修复前端 JS 两个语法错误（HTML_CONTENT 模板字符串内的 // 行注释吞掉了后续代码），导致整段前端 JS 从未执行：
//       A) setTimeout 箭头函数尾部 `// v0.1: 仅图片` 注释吞掉了 `},500);`
//       B) batchVerifyAccounts 行内 `// v0.1: keydraw 无 quota 端点` 注释吞掉了整段 if/else 分支与函数收尾
// v0.6: 修复 apiFetch 双 /api/ 前缀 bug — apiFetch 内部已自动 prepend '/api'，但调用方又传 '/api/...'，导致最终 URL 为 /api/api/image-tasks/...
//       影响 /image-tasks/generations、/image-tasks/{id}/resume-poll、/image-tasks/edits（multipart 图生图）三个端点。
//       上游 keydraw.97api.com 自荐站（V2EX 帖 https://www.v2ex.com/t/1222012）；免注册共享 Gift Key 模式；保留账号管理 / 历史记录 / 提示词库 / 参考图 / 通知。

// v1.0: 多通道架构 — 两个上游供应商
//   keydraw : https://keydraw.97api.com  (共享 Gift Key 模式，免注册)
//   maliang : https://grok.17nas.com/local-api  (用户名+密码注册，Cookie 鉴权)
// 前端通过 X-Channel 请求头告诉 Worker 当前用哪个上游；Worker 据此选择 UPSTREAM_BASE。
const CHANNELS = {
  keydraw: {
    upstreamBase: 'https://keydraw.97api.com',
    upstreamOrigin: 'https://keydraw.97api.com',
    authMode: 'bearer',  // Authorization: Bearer <key>
    sessionCookie: '',   // keydraw 不用 cookie
    giftKeyFallback: 'Gift-Key-V2EX999'
  },
  maliang: {
    upstreamBase: 'https://grok.17nas.com/local-api',
    upstreamOrigin: 'https://grok.17nas.com',
    authMode: 'cookie',  // Cookie: session=<token>
    sessionCookie: 'session',
    giftKeyFallback: ''
  }
};
const DEFAULT_CHANNEL = 'keydraw';
const SESSION_HEADER = 'X-Session-Token';  // 前端 → Worker 透传 token 的内部标记
const CHANNEL_HEADER = 'X-Channel';        // 前端 → Worker 指定上游通道

// ===================== HTML 前端 =====================
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI生图</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --accent:#3333CC;--accent-hover:#2768d9;--accent-light:rgba(51,51,204,.10);
  --bg:#FFF;--bg-card:#FFF;--bg-secondary:#F5F5F5;--bg-hover:#E2E8F0;
  --text:#1A202C;--text-secondary:#718096;--text-muted:#A0AEC0;
  --border:#E0E0E0;--border-medium:#CBD5E0;
  --radius:8px;--radius-xs:4px;
  --space-xs:4px;--space-sm:8px;--space-md:16px;--space-lg:24px;
  --font:"Noto Sans SC",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --mono:'SF Mono',Consolas,'Liberation Mono',Menlo,monospace;
  --purple:#6A5ACD;--green:#00CC00;--red:#FF0000;--yellow:#FFCC00;--gray:#666;
  --orange:#fdcb6e;--blue:#74b9ff;
}
[data-theme="dark"]{
  --bg:#0a0a0b;--bg-card:#141416;--bg-secondary:#1c1c20;--bg-hover:#242429;
  --text:#e8e6e3;--text-secondary:#a09f9d;--text-muted:#6b6a68;
  --border:#242429;--border-medium:#333;
  --accent:#6c5ce7;--accent-hover:#a29bfe;--accent-light:rgba(108,92,231,.12);
  --purple:#6A5ACD;--green:#00b894;--red:#e17055;--yellow:#fdcb6e;--gray:#888;
  --orange:#fdcb6e;--blue:#74b9ff;
}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--text);font-size:14px;line-height:1.6}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;font-size:13px;font-weight:600;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);cursor:pointer;font-family:var(--font);white-space:nowrap}
.btn:hover{background:var(--bg-hover);border-color:var(--border-medium)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:var(--purple);border-color:var(--purple);color:#fff}
.btn-primary:hover:not(:disabled){background:#5a4bbd}
.btn-outline{background:transparent;color:var(--accent);border-color:var(--accent)}
.btn-outline:hover:not(:disabled){background:var(--accent-light)}
.btn-ghost{border:none;background:transparent;color:var(--text-secondary);padding:4px 8px}
.btn-ghost:hover:not(:disabled){color:var(--text);background:var(--bg-secondary)}
.btn-danger-outline{background:transparent;color:var(--red);border-color:var(--red)}
.btn-danger-outline:hover:not(:disabled){background:rgba(255,0,0,.06)}
.btn-sm{padding:4px 10px;font-size:12px;border-radius:var(--radius-xs)}
.btn-xs{padding:2px 7px;font-size:11px;border-radius:var(--radius-xs)}
.btn-full{width:100%}
.btn-danger{border-color:var(--red);color:var(--red)}
.btn-danger:hover{background:var(--red);color:#fff}

/* Form controls */
.select-field{padding:8px 32px 8px 12px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-card);color:var(--text);outline:none;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23718096' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;width:100%;height:38px;font-family:var(--font)}
.select-field:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-light)}
.input-field{padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-card);color:var(--text);outline:none;line-height:1.5;width:100%;font-family:var(--font)}
.input-field::placeholder{color:var(--text-muted)}
.input-field:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-light)}
.checkbox-wrap{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text)}
.checkbox-wrap input[type="checkbox"]{appearance:none;-webkit-appearance:none;width:16px;height:16px;flex-shrink:0;border:2px solid var(--border-medium);border-radius:var(--radius-xs);background:var(--bg-card);cursor:pointer;position:relative}
.checkbox-wrap input[type="checkbox"]:hover{border-color:var(--accent)}
.checkbox-wrap input[type="checkbox"]:checked{background:var(--accent);border-color:var(--accent)}
.checkbox-wrap input[type="checkbox"]:checked::after{content:'';position:absolute;left:3px;top:0;width:6px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.icon-btn{background:none;border:none;cursor:pointer;padding:4px;color:var(--text-secondary)}
.icon-btn:hover{color:var(--accent)}

/* Nav */
#topNav{background:var(--bg-secondary);height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 var(--space-lg);border-bottom:1px solid var(--border);flex-shrink:0;gap:12px}.nav-left{display:flex;align-items:center;gap:8px}
#topNav .title{font-size:20px;font-weight:700}
.nav-right{display:flex;align-items:center;gap:12px}
.points{color:var(--accent);font-size:16px;font-weight:600}

/* Layout */
#mainWrap{display:flex;height:calc(100vh - 56px);overflow:hidden}
#leftPanel{width:380px;min-width:320px;overflow-y:auto;padding:var(--space-lg);border-right:1px solid var(--border);flex-shrink:0}
#centerPanel{flex:1;overflow-y:auto;padding:var(--space-lg)}

/* Left form */
#promptInput{min-height:100px;resize:vertical}
.prompt-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.dropdown-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.form-group{margin-bottom:12px}
.form-group label{display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500}
.form-label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.form-label-row label{margin-bottom:0}
.conditional-group{margin-top:10px}
.conditional-group label{display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500}
.hint-text{font-size:11px;color:var(--text-muted);margin-top:2px}

/* Ref upload */
.ref-grid{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ref-thumb{position:relative;width:56px;height:56px;border-radius:var(--radius-xs);overflow:hidden;border:1px solid var(--border);flex-shrink:0}
.ref-thumb img{width:100%;height:100%;object-fit:cover}
.ref-thumb .ref-del{position:absolute;top:1px;right:1px;width:14px;height:14px;border-radius:50%;background:var(--red);color:#fff;font-size:9px;line-height:14px;text-align:center;cursor:pointer;opacity:.8}
.ref-add{width:56px;height:56px;border:1px dashed var(--border);border-radius:var(--radius-xs);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-secondary);flex-shrink:0}
.ref-add:hover{border-color:var(--accent);color:var(--accent)}
.ref-add.dragover{border-color:var(--accent);color:var(--accent);background:var(--accent-light)}

/* Generate button */
.gen-btn{width:100%;height:48px;font-size:15px;font-weight:700;margin-top:14px;background:var(--purple);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font)}
.gen-btn:hover:not(:disabled){background:#5a4bbd}
.gen-btn:disabled{opacity:.4;cursor:not-allowed}

/* Extra buttons */
.extra-btns{display:flex;gap:8px;margin-top:10px}
.extra-btns .btn{flex:1;height:38px}

/* Task list */
.task-header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hdr-btns{margin-left:auto;display:flex;gap:6px}
.task-list{margin-top:14px;display:flex;flex-direction:column;gap:10px}

/* History items */
.hist-item{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid var(--border);border-radius:var(--radius)}
.hist-item.running-item{border-color:var(--accent)}
.status-icon{flex-shrink:0;margin-top:2px}
.hist-body{flex:1;min-width:0}
.hist-time{color:var(--text-muted);font-size:11px}
.hist-desc{margin-top:4px;font-size:13px;line-height:1.5;word-break:break-all}
.hist-actions{flex-shrink:0;display:flex;gap:6px;margin-top:2px}
.hist-status{font-size:11px;padding:1px 5px;border-radius:3px;font-weight:600;white-space:nowrap}
.hist-status.ok{background:var(--green);color:#fff}
.hist-status.err{background:var(--red);color:#fff}
.hist-status.timeout{background:var(--yellow);color:#111}
.hist-status.running{background:var(--blue);color:#111}
.hist-status.queued{background:var(--text-muted);color:#111}
.hist-prompt{padding:8px 12px;font-size:13px;white-space:pre-wrap;word-break:break-word;max-height:80px;overflow-y:auto;line-height:1.4}
.hist-error{padding:8px 12px;font-size:12px;color:var(--red);background:rgba(225,112,85,.06)}
.hist-progress{padding:8px 12px}
.hist-progress .pbar{height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.hist-progress .pfill{height:100%;background:var(--accent);border-radius:2px}
.hist-progress .ptxt{font-size:12px;color:var(--text-secondary);margin-top:4px;display:flex;align-items:center;gap:6px}
.hist-progress .ptxt .elapsed{color:var(--text-muted);font-family:var(--mono);font-size:11px;margin-left:auto}
.hist-img-link{padding:4px 12px 8px;font-size:12px}
.hist-img-link a{color:var(--accent);text-decoration:none;padding:2px 6px;border-radius:4px;background:var(--bg-secondary);display:inline-flex;align-items:center;gap:4px;font-size:12px}
.hist-img-link a:hover{background:var(--accent-light)}
.hist-model{font-size:12px;color:var(--text-secondary)}
.hist-account{font-size:11px;color:var(--text-muted)}

/* Spinner */
.spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%}

/* Modals */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:100}
.modal-backdrop.show{display:flex}
.modal{background:var(--bg-card);border-radius:10px;width:90%;max-width:560px;max-height:80vh;overflow-y:auto;border:1px solid var(--border)}
.modal-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center}
.modal-header h3{flex:1;font-size:15px;font-weight:600}
.modal-body{padding:18px}
.accounts-table{width:100%;border-collapse:collapse;font-size:13px}
.accounts-table th,.accounts-table td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)}
.accounts-table th{color:var(--text-muted);font-weight:500;font-size:11px;text-transform:uppercase}
.accounts-table tr:hover td{background:var(--bg-secondary)}

/* Help panel */
.help-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:90%;max-width:520px;max-height:80vh;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;z-index:150;display:none;flex-direction:column}
.help-panel.show{display:flex}
.help-panel-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center}
.help-panel-header h3{flex:1;font-size:15px;font-weight:600}
.help-panel-body{padding:16px 18px;overflow-y:auto;flex:1;font-size:13px;line-height:1.7;color:var(--text-secondary)}
.help-panel-body h4{color:var(--text);font-size:14px;margin:12px 0 6px;font-weight:600}
.help-panel-body h4:first-child{margin-top:0}
.help-panel-body ul{padding-left:16px;margin:4px 0 8px}
.help-panel-body li{margin:2px 0}
.help-panel-body code{background:var(--bg-secondary);padding:1px 4px;border-radius:3px;font-size:12px;font-family:var(--mono);color:var(--accent)}
.help-panel-body .changelog{font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:10px;margin-top:14px}
.help-panel-body .changelog dt{color:var(--text-secondary);font-weight:600;margin-top:8px}
.help-panel-body .changelog dd{margin:2px 0 4px 16px}

/* Theme switch */
.theme-switch{display:inline-flex;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.theme-btn{padding:5px 10px;border:none;background:var(--bg-secondary);color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:var(--font);white-space:nowrap}
.theme-btn:hover{background:var(--bg-hover)}
.theme-btn.active{background:var(--accent);color:#fff}

/* (watermark styles removed in v0.1) */

/* Prompt library panel */
.promptlib-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:90%;max-width:480px;max-height:80vh;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;z-index:170;display:none;flex-direction:column}
.promptlib-panel.show{display:flex}
.promptlib-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center}
.promptlib-header h3{flex:1;font-size:15px;font-weight:600}
.promptlib-body{padding:14px 18px;overflow-y:auto;flex:1}
.promptlib-item{padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg-secondary)}
.promptlib-item:hover{background:var(--bg-hover)}
.promptlib-item-text{font-size:13px;color:var(--text);white-space:pre-wrap;word-break:break-word;max-height:56px;overflow-y:hidden;line-height:1.4;cursor:pointer}
.promptlib-item-text:hover{color:var(--accent)}
.promptlib-item-meta{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--text-muted)}
.promptlib-item-meta button{font-size:10px}
.promptlib-empty{color:var(--text-muted);text-align:center;padding:36px 0;font-size:13px}
.promptlib-actions{display:flex;gap:6px;padding:10px 18px;border-top:1px solid var(--border)}

/* Toast */
/* v26: toast 移至右下角，避免遮挡右上角设置按钮 */
.toast-container{position:fixed;bottom:14px;right:14px;z-index:200;display:flex;flex-direction:column-reverse;gap:6px;max-width:calc(100vw - 28px)}
.toast{padding:8px 14px;border-radius:var(--radius);font-size:13px;max-width:340px;color:#fff}
.toast.success{background:var(--green)}
.toast.error{background:var(--red)}
.toast.info{background:var(--accent)}

/* Mobile drawer */
#historyDrawer{display:none}
@media(max-width:768px){
  #mainWrap{flex-direction:column}
  #leftPanel{width:100%;min-width:0;border-right:none;border-bottom:1px solid var(--border);overflow-y:visible;padding:var(--space-md)}
  #centerPanel{display:none}
  .dropdown-grid{grid-template-columns:1fr}
  #historyDrawer{
    display:flex;flex-direction:column;
    position:fixed;bottom:0;left:0;right:0;
    z-index:150;background:var(--bg-card);
  }
  .drawer-header{
    background:var(--bg-secondary);border-top:1px solid var(--border);
    padding:0 var(--space-lg);height:48px;
    display:flex;align-items:center;justify-content:space-between;
    flex-shrink:0;cursor:pointer;
  }
  .drawer-header h3{font-size:14px;font-weight:700}
  .drawer-header button{background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:4px}
  .drawer-body{
    display:none;
    max-height:65vh;overflow-y:auto;padding:var(--space-md);
    border-top:1px solid var(--border);
  }
  #historyDrawer.open .drawer-body{display:block}
}
@media(max-width:420px){
  .dropdown-grid{grid-template-columns:1fr}
  .drawer-body{max-height:75vh}
}

/* Scrollbar */
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text-muted)}

</style>
</head>
<body>

<nav id="topNav">
  <div class="title">AI生图</div>
  <div class="nav-left">
    <select id="channelSelect" class="select-field" onchange="onChannelChange()" title="上游通道" style="font-size:12px;padding:4px 8px;max-width:120px">
      <option value="auto">自动</option>
      <option value="keydraw">KeyDraw</option>
      <option value="maliang">马良</option>
    </select>
  </div>
  <div class="nav-right">
    <span class="points">剩余 <span id="usableCreditsTop">0</span> 张</span>
    <span id="concurrencyInfo" style="font-size:12px;color:var(--text-secondary)">并发: 0/0</span>
    <span id="totalCreditsTop" style="display:none">0</span>
    <span id="versionBadge" style="font-size:11px;color:var(--text-muted);font-family:var(--mono)" title="Worker 版本"></span>
    <button class="icon-btn" onclick="showSettingsModal()" title="设置">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </div>
</nav>

<div id="mainWrap">
  <div id="leftPanel">
    <textarea id="promptInput" class="input-field" placeholder="提示词"></textarea>

    <div class="prompt-actions">
      <button class="btn btn-ghost btn-sm" onclick="pasteToPrompt()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>粘贴
      </button>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('promptInput').value='';refImages=[];renderRefGrid()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>清空
      </button>
      <button class="btn btn-ghost btn-sm" onclick="showPromptLib()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>提示词库
      </button>
    </div>

    <div class="dropdown-grid">
      <select id="modelSelect" class="select-field" onchange="onModelChange()">
          <option value="gpt-image-2">GPT-Image-2 (1K)</option>
        </select>
      <select id="countSelect" class="select-field">
        <option value="1">1张</option>
        <option value="2">2张</option>
        <option value="3">3张</option>
        <option value="4">4张</option>
        <option value="5">5张</option>
        <option value="6">6张</option>
      </select>
      <select id="qualityTierSelect" class="select-field" onchange="onQualityTierChange()">
        <option value="standard">1.5K 标准</option>
        <option value="high">2.5K 高清</option>
        <option value="ultra">4K 超清</option>
      </select>
      <select id="ratioSelect" class="select-field" onchange="onRatioChange()">
        <option value="auto">智能</option>
        <option value="1:1" selected>1:1</option>
        <option value="3:2">3:2</option>
        <option value="2:3">2:3</option>
        <option value="16:9">16:9</option>
        <option value="9:16">9:16</option>
        <option value="4:3">4:3</option>
        <option value="3:4">3:4</option>
        <option value="5:4">5:4</option>
        <option value="4:5">4:5</option>
        <option value="2:1">2:1</option>
        <option value="1:2">1:2</option>
        <option value="21:9">21:9</option>
        <option value="9:21">9:21</option>
      </select>
    </div>
    <span id="modelAvailHint" class="hint-text" style="display:none;color:var(--red);margin-top:4px"></span>

    <div id="qualityTierGroup" style="display:none;margin-top:10px">
      <div class="form-label-row">
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500">画质档位</label>
        <span id="qualityTierHint" class="hint-text">1.5K·1024x1024·¥0.2/张</span>
      </div>
      <select id="qualityTierSelect2" class="select-field" onchange="onQualityTierChange2()">
        <option value="standard">1.5K 标准</option>
        <option value="high">2.5K 高清</option>
        <option value="ultra">4K 超清</option>
      </select>
    </div>

    <div id="durationGroup" style="display:none;margin-top:10px">
      <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500">视频时长</label>
      <select id="durationSelect" class="select-field">
        <option value="6">6 秒</option>
        <option value="10">10 秒</option>
        <option value="12">12 秒</option>
        <option value="16">16 秒</option>
        <option value="20">20 秒</option>
      </select>
    </div>

    <div id="videoResolutionGroup" style="display:none;margin-top:10px">
      <div class="form-label-row">
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500">视频清晰度</label>
        <span class="hint-text">上游仅支持480p和720p</span>
      </div>
      <select id="videoResolutionSelect" class="select-field" onchange="onVideoResolutionChange()">
        <option value="720p">720p</option>
        <option value="480p">480p</option>
      </select>
    </div>

    <div id="grokSizeHintGroup" style="display:none;margin-top:10px">
      <span id="grokSizeHintText" class="hint-text" style="color:var(--orange)"></span>
    </div>

    <div style="margin-top:14px">
      <label id="refLabel" style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500">参考图（可选）</label>
      <input type="file" id="refFileInput" accept="image/*" multiple style="display:none" onchange="handleRefImages(this)">
      <div class="ref-grid" id="refGrid"></div>
    </div>

    <button class="gen-btn" id="generateBtn" onclick="startGeneration()">生成图片</button>

    <div class="extra-btns">
    </div>
  </div>

  <div id="centerPanel">
    <div id="taskCard">
      <div class="task-header">
        <label class="checkbox-wrap"><input type="checkbox" id="ongoingChk" onchange="toggleOngoingFilter()"> 进行中</label>
        <div class="hdr-btns">
          <button class="btn btn-outline btn-sm" onclick="exportHistory()">导出</button>
          <button class="btn btn-danger-outline btn-sm" onclick="clearHistory()">清空</button>
        </div>
      </div>
      <div class="task-list" id="historyList">
        <p id="historyEmpty" style="color:var(--text-muted);text-align:center;padding:40px 0;font-size:13px">暂无历史记录</p>
      </div>
    </div>
  </div>
</div>

<!-- Mobile drawer -->
<div id="historyDrawer">
  <div class="drawer-header" onclick="toggleDrawer()">
    <h3>历史记录</h3>
    <button onclick="event.stopPropagation();toggleDrawer()" title="展开/收起">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
    </button>
  </div>
  <div class="drawer-body" id="drawerBody"></div>
</div>

<!-- Settings modal -->
<div class="modal-backdrop" id="settingsModal">
  <div class="modal">
    <div class="modal-header">
      <h3>设置</h3>
      <button class="btn btn-sm" onclick="closeSettingsModal()">关闭</button>
    </div>
    <div class="modal-body">
      <div style="margin-bottom:14px">
        <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;font-weight:500">外观主题</label>
        <div class="theme-switch">
          <button class="theme-btn" data-theme-val="system" onclick="setThemeMode('system')">跟随系统</button>
          <button class="theme-btn" data-theme-val="light" onclick="setThemeMode('light')">浅色</button>
          <button class="theme-btn" data-theme-val="dark" onclick="setThemeMode('dark')">深色</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="autoRegister()">注册新账号</button>
        <button class="btn btn-sm" onclick="addManualAccount()">手动添加</button>
        <button class="btn btn-sm" onclick="checkinAll()" title="上游已下线签到功能" style="opacity:.5;cursor:not-allowed">批量签到(已下线)</button>
        <button class="btn btn-sm" onclick="refreshAllQuota()">刷新额度</button>
        <button class="btn btn-sm btn-outline" onclick="cleanupInsufficientAccounts()" title="扫描所有账号，余额不足以生成 1 张图的自动移入废弃池">清理无余额账号</button>
        <button class="btn btn-sm" onclick="batchVerifyAccounts()">批量验证</button>
        <button class="btn btn-sm" onclick="showInvitePanel()">邀请好友</button>
        <a href="https://grok.17nas.com" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none">官网注册</a>
      </div>
      <div id="accountsTableContainer" style="overflow-x:auto;margin-bottom:14px"></div>
      <div id="abandonedPoolContainer" style="overflow-x:auto;margin-bottom:14px"></div>
      <div id="storageInfoContainer" style="margin-bottom:14px"></div>
      <div id="invitePanelContainer" style="display:none;margin-bottom:14px;padding:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-secondary)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:13px;font-weight:600;color:var(--text)">邀请好友</span>
          <button class="btn btn-xs btn-ghost" onclick="closeInvitePanel()">关闭</button>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">好友通过链接注册后，双方均可获得额度奖励</div>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="text" id="inviteLinkInput" readonly class="input-field" style="flex:1;font-family:var(--mono);font-size:12px">
          <button class="btn btn-sm btn-outline" onclick="copyInviteLink()">复制链接</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11px;color:var(--text-muted);margin-right:4px">导出：</span>
        <button class="btn btn-sm btn-outline" onclick="exportAccounts('all')" title="导出可用账号 + 废弃池（导出前会自动检测废弃）">全部</button>
        <button class="btn btn-sm btn-outline" onclick="exportAccounts('active')" title="仅导出可用账号（导出前会自动检测废弃）">仅可用</button>
        <button class="btn btn-sm btn-outline" onclick="exportAccounts('abandoned')" title="仅导出废弃池账号">仅废弃池</button>
        <button class="btn btn-sm" onclick="importAccounts()">导入账号</button>
      </div>
      <input type="file" id="importFileInput" accept=".json" style="display:none" onchange="handleImportFile(this)">
      <input type="file" id="importHistoryInput" accept=".json" style="display:none" onchange="handleImportHistory(this)">
      <input type="file" id="importPromptLibInput" accept=".json" style="display:none" onchange="handleImportPromptLib(this)">
      <div style="border-top:1px solid var(--border);padding-top:14px">
        <div class="form-group">
          <label>默认密码（自动追加yymmdd日期后缀）</label>
          <input type="text" id="defaultPassword" class="input-field" value="Ml@2026Proxy">
        </div>
        <div class="form-group">
          <label>轮换策略</label>
          <select id="rotationStrategy" class="select-field">
            <option value="most-credits">优先额度最多</option>
            <option value="round-robin">轮询</option>
            <option value="newest">优先最新</option>
          </select>
        </div>
        <div class="form-group"><label class="checkbox-wrap" title="上游已下线签到功能，此选项已无效"><input type="checkbox" id="autoCheckin" checked disabled style="opacity:.5"> 额度耗尽自动签到 <span style="color:var(--text-muted);font-size:11px">(上游已下线)</span></label></div>
        <div class="form-group"><label class="checkbox-wrap"><input type="checkbox" id="autoRegisterChk" checked> 额度耗尽自动注册</label></div>
        <div class="form-group"><label class="checkbox-wrap"><input type="checkbox" id="autoFallbackGpt2" checked disabled style="opacity:.5"> 其他模型失败时自动换用 GPT-Image-2 重试 <span style="color:var(--text-muted);font-size:11px">(v0.1 仅 gpt-image-2，已禁用)</span></label></div>
        <div class="form-group">
          <label class="checkbox-wrap"><input type="checkbox" id="notificationsEnabled" onchange="onNotificationsToggle(this.checked)"> 生成完成浏览器通知提醒</label>
          <div class="hint-text" id="notificationsHint" style="margin-top:2px"></div>
        </div>
        <button class="btn btn-primary" onclick="saveSettings()">保存设置</button>
      </div>
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:10px;display:flex;gap:6px;align-items:center">
        <button class="btn btn-sm btn-outline" onclick="toggleHelpPanel()">使用帮助 & 更新日志</button>
        <button class="btn btn-sm btn-danger" onclick="clearAllData()">清除所有数据</button>
      </div>
    </div>
  </div>
</div>

<!-- Help panel -->
<div class="help-panel" id="helpPanel">
  <div class="help-panel-header">
    <h3>使用说明 & 更新日志</h3>
    <button class="btn btn-sm" onclick="toggleHelpPanel()">关闭</button>
  </div>
  <div class="help-panel-body">
    <h4>产品简介</h4>
    <p>AI生图 Beta 是基于 Cloudflare Worker 的免费 AI 图片生成服务，上游为 <a href="https://keydraw.97api.com" target="_blank">keydraw.97api.com</a>（V2EX 自荐站，免注册共享 Gift Key 模式），仅支持 <code>gpt-image-2</code> 模型 1K 分辨率出图。</p>

    <h4>主要功能</h4>
    <ul>
      <li><strong>模型</strong>：仅 <code>gpt-image-2</code>（上游 keydraw.97api.com 限制）</li>
      <li><strong>并发生成</strong>：每个账号 3 个并发槽位，多账号叠加</li>
      <li><strong>账号池管理</strong>：自动注册、手动添加、批量验证、智能轮换（注：上游已下线签到功能）</li>
      <li><strong>参考图生成</strong>：图生图/图生视频</li>
      <li><strong>历史记录</strong>：自动保存，支持导入导出</li>
      <li><strong>提示词库</strong>：收藏常用提示词，支持导入导出</li>
      <li><strong>深浅色模式</strong>：跟随系统/浅色/深色</li>
    </ul>

    <h4>使用方法</h4>
    <ul>
      <li>首次使用：点击右上角设置图标，注册新账号</li>
      <li>生成图片：输入提示词，选择模型/比例/数量，点击生成</li>
      <li>一键粘贴：点击提示词旁的粘贴按钮</li>
      <li>参考图：点击上传参考图（图生图/图生视频）</li>
      <li>管理账号：设置面板中可签到/删除/导出/导入账号</li>
    </ul>

    <h4>注意事项</h4>
    <ul>
      <li>base64 图片为临时数据，刷新后将丢失，请及时下载</li>
      <li>URL 图片通过代理加载，刷新后可恢复</li>
      <li>上游 keydraw.97api.com 无签到概念，新额度通过刷新 Gift Key 或注册新 key 获取</li>
      <li>关闭页面前请保存图片，可导出设置/历史/提示词库</li>
    </ul>

    <dl class="changelog">
      <dt>v0.4 (当前)</dt>
      <dd>修复 <code>client_task_id</code> 格式 bug：上游 keydraw 要求 <code>timestamp-randomhex</code> 格式（例如 <code>1783440890123-3d70ac176c97</code>），旧版用 base36 时间戳 + 下划线 + 索引会被静默拒绝（返回误导性错误"生成数量只能是 1、2、3、4"）。</dd>
      <dd>新增 <code>genClientTaskId()</code> 辅助函数；<code>executeTask</code> 内 <code>client_task_id</code> 改用此函数生成。</dd>
      <dt>v0.3</dt>
      <dd>修复后端代理两个关键 bug：① <code>handleProxy</code> 错误剥离 <code>/api/</code> 前缀导致上游 404；② 前端发送的 <code>Authorization: Bearer</code> 头未透传到上游。</dd>
      <dd>新增 <code>VERSION</code> 常量与右上角版本徽章，方便确认部署版本。</dd>
      <dt>v0.2</dt>
      <dd>清理 v0.1 遗留的"添加水印"模态框收尾 HTML 片段与"去除水印"面板（<code>#removeWmPanel</code>），UI 中再无水印相关入口。</dd>
      <dt>v0.1</dt>
      <dd>首个 beta 版本。上游从 <code>grok.17nas.com/local-api</code>（马良生图镜像）切换为 <code>keydraw.97api.com</code>（V2EX 自荐站 <a href="https://www.v2ex.com/t/1222012" target="_blank">t/1222012</a>）。</dd>
      <dd>免注册共享 Gift Key 模式：GET <code>/api/gift-key</code> 返回固定 key <code>Gift-Key-V2EX999</code>，无需邮箱 / 验证码 / OAuth 即可使用。</dd>
      <dd>移除"添加水印"和"去除水印"功能（HTML 面板 / CSS / JS 函数 / 内嵌 base64 alpha map 全部删除）。</dd>
      <dd>模型清单精简为 <code>gpt-image-2</code>（上游仅支持 1K 分辨率，1024x1024）。</dd>
      <dd>生成端点改为 POST <code>/api/image-tasks/generations</code>（请求体：<code>{client_task_id, prompt, model, size, quality}</code>）。</dd>
      <dd>轮询端点改为 POST <code>/api/image-tasks/{id}/resume-poll</code>（长轮询，可阻塞 120 秒）+ GET <code>/api/image-tasks?ids=...</code>。</dd>
      <dd>图生图端点改为 POST <code>/api/image-tasks/edits</code>（multipart：<code>image, client_task_id, prompt, model, size, quality</code>）。</dd>
      <dd>账号模型从"用户名+密码+sessionToken"改为"key 列表"，每个账号就是一个 gift key 或用户自定义 key。账号池轮换 / 废弃 / 自动补充逻辑保留。</dd>
      <dd>保留：账号管理（导入导出 / 批量验证 / 废弃池）、历史记录、提示词库、参考图、浏览器通知、深浅色模式、自动换号 fallback。</dd>
      <dd>签到：上游无签到概念，按钮置灰并显示"上游不支持"，保留 UI 入口以兼容旧设置。</dd>
    </dl>
  </div>
</div>


<!-- Prompt library panel -->
<div class="promptlib-panel" id="promptLibPanel">
  <div class="promptlib-header">
    <h3>提示词库</h3>
    <button class="btn btn-sm" onclick="closePromptLib()">关闭</button>
  </div>
  <div class="promptlib-body" id="promptLibList">
    <p class="promptlib-empty" id="promptLibEmpty">暂无收藏的提示词</p>
  </div>
  <div class="promptlib-actions">
    <button class="btn btn-sm btn-outline" onclick="exportPromptLib()">导出</button>
    <button class="btn btn-sm" onclick="importPromptLib()">导入</button>
    <button class="btn btn-sm btn-danger" onclick="clearPromptLib()">清空</button>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>

<script>
const VERSION='v1.0';
const STATE_KEY='maliang_state',HISTORY_KEY='maliang_history',PROMPTLIB_KEY='maliang_promptlib';
// v1.0: 前端副本 —— 顶层 worker 常量在前端不可见，需在 script 内重复定义
const CHANNELS={
  keydraw:{upstreamBase:'https://keydraw.97api.com',upstreamOrigin:'https://keydraw.97api.com',authMode:'bearer',sessionCookie:'',giftKeyFallback:'Gift-Key-V2EX999'},
  maliang:{upstreamBase:'https://grok.17nas.com/local-api',upstreamOrigin:'https://grok.17nas.com',authMode:'cookie',sessionCookie:'session',giftKeyFallback:''}
};
const DEFAULT_CHANNEL='keydraw';
const SESSION_HEADER='X-Session-Token';
const CHANNEL_HEADER='X-Channel';
let state=loadState(),generationHistory=loadHistory(),promptLibrary=loadPromptLib();

// 运行时完整图片存储（不存localStorage，避免爆容量）
const liveImages=new Map(); // id -> [{type,value}]
// 并发相关变量
const CONCURRENT_PER_ACCOUNT=3;
let activeSlots=0;
const taskStartTimes=new Map();
let selectedRatio='1:1',refImages=[],selectedDuration=6,selectedQualityTier='standard',selectedVideoResolution='720p';
// 存储配额缓存: accountId -> {mediaUsageBytes, mediaQuotaMb, usagePercent}
const storageCache=new Map();
// 邀请码缓存: accountId -> {inviteCode, inviteLink}
const inviteCache=new Map();

// ===== 模型可用性预检 =====
// 系统配置的标志(grok2apiI2vProxyEnabled等)不可靠，需实际探测
let modelAvailability = { videoAvailable: null, models: [], lastCheck: 0, videoError: '' };

async function refreshModelAvailability() {
  // v0.7: keydraw.97api.com 无 /account/quota 与 /proxy/videos 端点，整个模型可用性探测改为 no-op。
  //       keydraw 仅提供 gpt-image-2 一个模型，UI 已硬编码此选项，无需动态探测。
  return;
}

function updateModelAvailabilityUI() {
  var model = document.getElementById('modelSelect').value;
  var hintEl = document.getElementById('modelAvailHint');
  if (!hintEl) return;
  hintEl.style.color = 'var(--red)';
  if (model === 'grok-imagine-video' && modelAvailability.videoAvailable === false) {
    hintEl.textContent = modelAvailability.videoError || '视频模型已临时下架，暂不可用';
    hintEl.style.display = 'block';
  } else if (model === 'grok-imagine-video' && modelAvailability.videoAvailable === null) {
    hintEl.textContent = '视频模型可用性未知，尝试生成时确认';
    hintEl.style.color = 'var(--orange)';
    hintEl.style.display = 'block';
  } else {
    hintEl.textContent = '';
    hintEl.style.display = 'none';
  }
}

// ===== 模型类型判断 =====
function isVideoModel(m){return m==='grok-imagine-video'}
function isGptImg(m){return m==='gpt-image-2'||m==='grok-imagine-image-edit'}
function supportsRefImage(m){return isGptImg(m)||isVideoModel(m)}

// ===== 模型切换处理 =====
function onModelChange(){
  var model=document.getElementById('modelSelect').value;
  var durGroup=document.getElementById('durationGroup');
  var btn=document.getElementById('generateBtn');
  var refLabel=document.getElementById('refLabel');
  var qtGroup=document.getElementById('qualityTierGroup');
  var vrGroup=document.getElementById('videoResolutionGroup');
  durGroup.style.display=isVideoModel(model)?'block':'none';
  vrGroup.style.display=isVideoModel(model)?'block':'none';
  qtGroup.style.display=(model==='gpt-image-2')?'block':'none';
  var qtSelect=document.getElementById('qualityTierSelect');if(qtSelect){qtSelect.disabled=(model!=='gpt-image-2');qtSelect.style.opacity=(model==='gpt-image-2')?'1':'0.4'}
  btn.textContent=isVideoModel(model)?'生成视频':'生成图片';
  if(isVideoModel(model)){refLabel.textContent='参考图（可选，图生视频，可多张）'}
  else if(isGptImg(model)){refLabel.textContent='参考图（可选，图生图，可多张）'}
  else{refLabel.textContent='参考图（可选，可多张）'}
  if(model==='gpt-image-2'){updateQualityTierHint()}
  updateGrokSizeHint();
  updateModelAvailabilityUI();
  // v25: 模型/档位变化时刷新 topbar 和账号表（可生成图片数会变）
  renderTopbar();
  updateConcurrencyUI();
  if(document.getElementById('settingsModal').classList.contains('show')){
    renderAccountsTable();
  }
}

// ===== 主题管理 =====
function getThemeMode(){return state.settings.theme||'system'}
function getEffectiveTheme(mode){if(mode==='system'){return window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark'}return mode}
function applyTheme(){var mode=getThemeMode();var effective=getEffectiveTheme(mode);document.documentElement.setAttribute('data-theme',effective);document.querySelectorAll('.theme-btn').forEach(function(btn){btn.classList.toggle('active',btn.getAttribute('data-theme-val')===mode)})}
function setThemeMode(mode){state.settings.theme=mode;saveState();applyTheme()}
if(window.matchMedia){window.matchMedia('(prefers-color-scheme:light)').addEventListener('change',function(){if(getThemeMode()==='system')applyTheme()})}

// ===== 提示词库 =====
function loadPromptLib(){try{var r=localStorage.getItem(PROMPTLIB_KEY);if(r)return JSON.parse(r)}catch(e){}return[]}
function savePromptLib(){try{localStorage.setItem(PROMPTLIB_KEY,JSON.stringify(promptLibrary))}catch(e){}}
function addToPromptLib(text){
  if(!text||!text.trim())return;
  text=text.trim();
  if(promptLibrary.some(function(p){return p.text===text})){toast('该提示词已在词库中','info');return}
  promptLibrary.unshift({id:Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),text:text,addedAt:Date.now()});
  savePromptLib();
  renderPromptLib();
  toast('已加入提示词库','success');
}
function removeFromPromptLib(el){
  var wrapper=el.closest('[data-prompt-id]');
  if(!wrapper)return;
  var id=wrapper.getAttribute('data-prompt-id');
  promptLibrary=promptLibrary.filter(function(p){return p.id!==id});
  savePromptLib();
  renderPromptLib();
  toast('已从词库删除','success');
}
function usePromptFromLib(el){
  var wrapper=el.closest('[data-prompt-id]');
  if(!wrapper)return;
  var id=wrapper.getAttribute('data-prompt-id');
  var item=promptLibrary.find(function(p){return p.id===id});
  if(!item)return;
  var inputEl=document.getElementById('promptInput');
  if(inputEl.value&&!confirm('当前提示词已有内容，是否覆盖？')){return}
  inputEl.value=item.text;
  closePromptLib();
  toast('已填入提示词','success');
}
function showPromptLib(){renderPromptLib();document.getElementById('promptLibPanel').classList.add('show')}
function closePromptLib(){document.getElementById('promptLibPanel').classList.remove('show')}
function renderPromptLib(){
  var c=document.getElementById('promptLibList');
  var empty=document.getElementById('promptLibEmpty');
  c.querySelectorAll('.promptlib-item').forEach(function(el){el.remove()});
  if(!promptLibrary.length){if(empty)empty.style.display='';return}
  if(empty)empty.style.display='none';
  promptLibrary.forEach(function(item){
    var div=document.createElement('div');
    div.className='promptlib-item';
    var t=new Date(item.addedAt);
    var ts=String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0')+' '+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
    div.setAttribute('data-prompt-id',item.id);
    div.innerHTML='<div class="promptlib-item-text" onclick="usePromptFromLib(this)">'+escHtml(item.text)+'</div>'
      +'<div class="promptlib-item-meta"><span>'+ts+'</span>'
      +'<button class="btn btn-xs btn-ghost" onclick="copyPromptText(this)">复制</button>'
      +'<button class="btn btn-xs btn-ghost" style="color:var(--red)" onclick="removeFromPromptLib(this)">删除</button></div>';
    c.appendChild(div);
  });
}
function copyPromptText(el){
  var wrapper=el.closest('[data-prompt-id]');
  if(!wrapper)return;
  var id=wrapper.getAttribute('data-prompt-id');
  var item=promptLibrary.find(function(p){return p.id===id});
  if(!item)return;
  navigator.clipboard.writeText(item.text).then(function(){toast('已复制','success')}).catch(function(){toast('复制失败','error')});
}
function exportPromptLib(){
  if(!promptLibrary.length){toast('提示词库为空','info');return}
  var b=new Blob([JSON.stringify(promptLibrary,null,2)],{type:'application/json'});
  var u=URL.createObjectURL(b);var a=document.createElement('a');
  a.href=u;a.download='prompt_library_'+new Date().toISOString().split('T')[0]+'.json';
  a.click();URL.revokeObjectURL(u);toast('提示词库已导出','success');
}
function importPromptLib(){document.getElementById('importPromptLibInput').click()}
function handleImportPromptLib(input){
  var file=input.files[0];if(!file)return;
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      var data=JSON.parse(e.target.result);
      var arr=Array.isArray(data)?data:[data];
      var n=0;
      arr.forEach(function(item){
        if(item.text&&!promptLibrary.some(function(p){return p.text===item.text})){
          promptLibrary.push({id:item.id||Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),text:item.text,addedAt:item.addedAt||Date.now()});
          n++;
        }
      });
      if(n>0){savePromptLib();renderPromptLib();toast('导入'+n+'条提示词','success')}
      else{toast('无新提示词可导入','info')}
    }catch(err){toast('导入失败: '+err.message,'error')}
  };
  reader.readAsText(file);
  input.value='';
}
function clearPromptLib(){if(!confirm('确定清空提示词库？'))return;promptLibrary=[];savePromptLib();renderPromptLib();toast('提示词库已清空','success')}

// ===== 一键粘贴 =====
async function pasteToPrompt(){
  try{
    var text=await navigator.clipboard.readText();
    if(!text||!text.trim()){toast('剪贴板为空','info');return}
    var el=document.getElementById('promptInput');
    if(el.value&&!confirm('当前提示词已有内容，是否覆盖？'))return;
    el.value=text;
    toast('已粘贴','success');
  }catch(e){toast('无法读取剪贴板，请手动粘贴','error')}
}

// ===== 历史记录提示词操作 =====
function copyHistPrompt(el){
  var histId=el.closest('[data-hist-id]');
  if(!histId)return;
  var id=histId.getAttribute('data-hist-id');
  var h=generationHistory.find(function(x){return x.id===id});
  if(!h)return;
  navigator.clipboard.writeText(h.prompt).then(function(){toast('已复制提示词','success')}).catch(function(){toast('复制失败','error')});
}
function addHistPromptToLib(el){
  var histId=el.closest('[data-hist-id]');
  if(!histId)return;
  var id=histId.getAttribute('data-hist-id');
  var h=generationHistory.find(function(x){return x.id===id});
  if(!h)return;
  addToPromptLib(h.prompt);
}

// 从localStorage恢复url类型图片到liveImages
function restoreLiveImages(){
  generationHistory.forEach(h=>{
    if(h.images&&h.images.length){
      const restored=h.images.filter(img=>img.type==='url'&&img.value).map(img=>({type:img.type,value:img.value}));
      if(restored.length) liveImages.set(h.id,restored);
    }
    if(h.startedAt&&h.startedAt>0){taskStartTimes.set(h.id,h.startedAt)}
    else if(h.timestamp){taskStartTimes.set(h.id,h.timestamp)}
  });
}

function markInterruptedTasks(){
  let changed=false;
  generationHistory.forEach(h=>{if(h.status==='running'||h.status==='queued'){h.status='error';h.error='页面刷新，任务已中断';h.progressText='已中断';changed=true}});
  if(changed){saveHistory()}
}

function defaultState(){return{
  // v1.0: 多通道账号池 —— 每个通道独立维护账号列表
  accountsByKeydraw:[],accountsByMaliang:[],
  abandonedAccountsByKeydraw:[],abandonedAccountsByMaliang:[],
  // 兼容旧字段：state.accounts 现在指向当前通道的池子（运行时同步）
  accounts:[],abandonedAccounts:[],
  // v1.0: 通道选择 —— 'auto' | 'keydraw' | 'maliang'
  activeChannel:'auto',lastChannel:'keydraw',
  settings:{defaultPassword:'Ml@2026Proxy',rotationStrategy:'most-credits',autoCheckin:true,autoRegister:true,autoFallbackGpt2:true,theme:'system',notificationsEnabled:false},
  activeAccountIndex:-1,rotationIndex:0,lastAutoDay:''
}}
function loadState(){try{const r=localStorage.getItem(STATE_KEY);if(r){const s=JSON.parse(r);return{...defaultState(),...s,settings:{...defaultState().settings,...(s.settings||{})}}}}catch(e){}return defaultState()}
function saveState(){localStorage.setItem(STATE_KEY,JSON.stringify(state))}
function loadHistory(){try{const r=localStorage.getItem(HISTORY_KEY);if(r)return JSON.parse(r)}catch(e){}return[]}
function saveHistory(){try{localStorage.setItem(HISTORY_KEY,JSON.stringify(generationHistory))}catch(e){}}

function addHistory(entry){
  if(entry.images&&entry.images.length){
    liveImages.set(entry.id,entry.images.map(img=>({type:img.type,value:img.value})));
    entry.images=entry.images.map(img=>{if(img.type==='url')return{type:'url',value:img.value};return{type:'live',value:'in_liveImages'}});
  }
  generationHistory.unshift(entry);
  if(generationHistory.length>300){const removed=generationHistory.splice(300);removed.forEach(h=>liveImages.delete(h.id))}
  saveHistory();
  try{renderHistoryItem(entry)}catch(e){console.warn('renderHistoryItem failed:',e)}
}

function updateHistory(id,updates){
  const idx=generationHistory.findIndex(h=>h.id===id);
  if(idx<0)return;
  const h=generationHistory[idx];
  if(updates.images&&updates.images.length){
    const first=updates.images[0];
    if(first&&first.type!=='live'){
      liveImages.set(id,updates.images.map(img=>({type:img.type,value:img.value})));
      updates.images=updates.images.map(img=>{if(img.type==='url')return{type:'url',value:img.value};return{type:'live',value:'in_liveImages'}});
    }
  }
  Object.assign(h,updates);
  saveHistory();
  try{patchHistoryItem(h)}catch(e){console.warn('patchHistoryItem failed:',e)}
}

function clearHistory(){if(!confirm('确定清空历史？'))return;generationHistory=[];liveImages.clear();saveHistory();renderFullHistory();toast('历史已清空','success')}

// ===== 图片错误处理 =====
function handleImgError(img){
  if(img._err)return;
  img._err=1;
  var rawSrc=img.dataset.raw||'';
  if(rawSrc.startsWith('http')){img._err=0;tryConvertUrlToB64(img,rawSrc);return}
  img.style.display='none';
  var p=img.parentElement;
  var a=document.createElement('a');
  a.href=img.dataset.raw;a.target='_blank';a.textContent='查看和保存原图';a.className='hist-img-link';
  p.appendChild(a);
}

async function tryConvertUrlToB64(imgEl,rawUrl){
  try{
    var proxyUrl='/api/media-proxy?url='+encodeURIComponent(rawUrl);
    var fetchOpts={};
    // 传递当前账号的session token，以便媒体代理能通过上游认证
    var acc=state.accounts.find(function(a){return a.sessionToken});
    if(acc&&acc.sessionToken){fetchOpts.headers={'X-Session-Token':acc.sessionToken}}
    var resp=await fetch(proxyUrl,fetchOpts);
    if(!resp.ok)throw new Error('proxy failed: '+resp.status);
    var blob=await resp.blob();
    var reader=new FileReader();
    reader.onload=function(){
      var b64Url=reader.result;
      imgEl.src=b64Url;imgEl.style.display='';
      var histId=imgEl.closest('[data-hist-id]');
      if(histId){
        var id=histId.getAttribute('data-hist-id');
        var imgs=liveImages.get(id);
        if(imgs){imgs.forEach(function(im){if(im.value===rawUrl||im.type==='url'&&im.value===rawUrl){im.type='b64';im.value=b64Url}});var hist=generationHistory.find(function(h){return h.id===id});if(hist)saveHistory()}
      }
    };
    reader.readAsDataURL(blob);
  }catch(e){
    console.warn('图片代理转换失败:',e.message);
    imgEl._err=1;imgEl.style.display='none';
    var p=imgEl.parentElement;var a=document.createElement('a');
    a.href=rawUrl;a.target='_blank';a.textContent='查看和保存原图';a.className='hist-img-link';p.appendChild(a);
  }
}

// ===== API =====
// v1.0: 通道感知的 apiFetch —— 自动附加 X-Channel 头与对应的鉴权头
function getActiveChannel(){
  // v1.0: 实际生效的通道（'auto' 解析为 lastChannel），fallback 'keydraw'（向后兼容旧 state）
  // 注意：函数可能在 state 初始化前被调用，需做 nullish 防护
  if(state && state.activeChannel && state.activeChannel !== 'auto') return state.activeChannel;
  if(state && state.lastChannel) return state.lastChannel;
  return DEFAULT_CHANNEL;
}
function getChannelAuthHeaders(channel, token){
  const ch = CHANNELS[channel];
  if(!ch) return {};
  if(ch.authMode === 'bearer' && token) return {'Authorization':'Bearer '+token};
  if(ch.authMode === 'cookie' && token) return {'Cookie': ch.sessionCookie+'='+token};
  return {};
}
async function apiFetch(path,options={}){
  const url='/api'+path;
  const st=options._sessionToken||null;
  const channel=options._channel||getActiveChannel();
  const headers={'Content-Type':'application/json',...(options.headers||{})};
  // v1.0: 通道头永远带上
  headers[CHANNEL_HEADER]=channel;
  // 鉴权头按通道类型决定（keydraw=Bearer, maliang=Cookie）
  Object.assign(headers, getChannelAuthHeaders(channel, st));
  return fetch(url,{...options,headers,credentials:'omit'});
}
// v1.0: multipart 版本（图生图 /image-tasks/edits），同样需要带通道头
async function apiFetchMultipart(path,formData,sessionToken,channel){
  const url='/api'+path;
  const ch=channel||getActiveChannel();
  const headers={};
  headers[CHANNEL_HEADER]=ch;
  Object.assign(headers, getChannelAuthHeaders(ch, sessionToken));
  return fetch(url,{method:'POST',headers,body:formData,credentials:'omit'});
}

// v1.0: 通道切换 —— 用户改 channelSelect 时调用
function onChannelChange(){
  var sel=document.getElementById('channelSelect');
  if(!sel)return;
  state.activeChannel=sel.value;
  // 'auto' 模式下不重置 lastChannel（保留上次选择），固定通道模式下立即切换
  if(sel.value!=='auto'){
    state.lastChannel=sel.value;
  }
  // 同步当前通道的账号池到 state.accounts（兼容旧代码）
  syncAccountsToActiveChannel();
  saveState();
  // 重置账号选择索引
  state.activeAccountIndex=state.accounts.length>0?0:-1;
  state.rotationIndex=0;
  saveState();
  renderAll();
  renderAccountsTable?.();
  // 触发当前通道的自动注册/恢复
  ensureChannelReady();
}
// v1.0: 把当前通道的账号池同步到 state.accounts（让旧代码无感知地继续工作）
function syncAccountsToActiveChannel(){
  var ch=effectiveChannel();
  if(ch==='keydraw'){state.accounts=state.accountsByKeydraw||[];state.abandonedAccounts=state.abandonedAccountsByKeydraw||[]}
  else if(ch==='maliang'){state.accounts=state.accountsByMaliang||[];state.abandonedAccounts=state.abandonedAccountsByMaliang||[]}
}
// v1.0: 实际生效的通道（'auto' 解析为 lastChannel）
function effectiveChannel(){
  if(state.activeChannel==='auto'||!state.activeChannel)return state.lastChannel||DEFAULT_CHANNEL;
  return state.activeChannel;
}
// v1.0: 把当前 state.accounts 写回对应通道的池子
function persistActiveChannelAccounts(){
  var ch=effectiveChannel();
  if(ch==='keydraw'){state.accountsByKeydraw=state.accounts;state.abandonedAccountsByKeydraw=state.abandonedAccounts}
  else if(ch==='maliang'){state.accountsByMaliang=state.accounts;state.abandonedAccountsByMaliang=state.abandonedAccounts}
}
// v1.0: 老代码 registerAccount/saveState 之前 hook 一下，确保账号写回正确通道池
var _origSaveState=saveState;
saveState=function(){persistActiveChannelAccounts();_origSaveState()};
// v1.0: 迁移旧 state（只有 state.accounts、无 accountsByKeydraw）到 keydraw 通道
function migrateOldStateIfNeeded(){
  if(state.accountsByKeydraw===undefined){
    state.accountsByKeydraw=state.accounts||[];
    state.abandonedAccountsByKeydraw=state.abandonedAccounts||[];
    state.accountsByMaliang=state.accountsByMaliang||[];
    state.abandonedAccountsByMaliang=state.abandonedAccountsByMaliang||[];
    if(!state.activeChannel)state.activeChannel='auto';
    if(!state.lastChannel)state.lastChannel='keydraw';
  }
}
// v1.0: 启动时确保当前通道有可用账号（keydraw 自动 gift-key，maliang 自动注册）
async function ensureChannelReady(){
  migrateOldStateIfNeeded();
  syncAccountsToActiveChannel();
  var ch=effectiveChannel();
  if(ch==='keydraw'){
    if(!state.accounts.length){try{await registerAccount()}catch(e){console.warn('keydraw gift-key 失败:',e.message)}}
  } else if(ch==='maliang'){
    if(!state.accounts.length){
      if(state.settings.autoRegister!==false){try{await registerAccount()}catch(e){toast('马良自动注册失败: '+e.message,'error')}}
    } else {
      // 已有账号，确保 sessionToken 还有效
      var acc=state.accounts.find(function(a){return a.sessionToken&&!a.disabled});
      if(!acc){try{await loginAccount(0)}catch(e){}}
    }
  }
  refreshModelAvailability();
}

// ===== 会话过期检测 (v24) =====
// 上游在 session token 失效时会返回 "请先登录" 等错误，此时需要清除旧 token 重新登录
function isAuthError(msg){
  if(!msg)return false;
  msg=String(msg);
  return msg.includes('请先登录')||msg.includes('未登录')||msg.includes('会话已过期')||msg.includes('无效会话')||msg.includes('token expired')||msg.includes('session expired')||msg.includes('unauthorized')||msg.includes('请重新登录');
}

// 通过 session token 反向查找账号索引
function findAccountIndexByToken(st){
  if(!st)return -1;
  return state.accounts.findIndex(function(a){return a.sessionToken===st});
}

// 通过用户名查找账号索引
function findAccountIndexByUsername(username){
  if(!username)return -1;
  return state.accounts.findIndex(function(a){return a.username===username});
}

// 尝试为指定账号重新登录，返回新的 session token 或 null
async function tryRelogin(accountIndex){
  if(accountIndex<0||accountIndex>=state.accounts.length)return null;
  var acc=state.accounts[accountIndex];
  if(!acc)return null;
  // 清除旧 token，避免使用过期会话
  acc.sessionToken='';
  saveState();
  try{
    await loginAccount(accountIndex);
    return state.accounts[accountIndex].sessionToken||null;
  }catch(e){
    console.warn('重新登录失败('+acc.username+'):',e.message);
    return null;
  }
}

// ===== 浏览器通知 (v24) =====
function notificationsSupported(){
  return typeof Notification!=='undefined';
}
function notificationsEnabled(){
  return !!(state.settings.notificationsEnabled&&notificationsSupported()&&Notification.permission==='granted');
}
async function requestNotificationPermission(){
  if(!notificationsSupported()){
    toast('当前浏览器不支持通知','error');
    return false;
  }
  if(Notification.permission==='granted')return true;
  if(Notification.permission==='denied'){
    toast('通知权限已被浏览器拒绝，请在浏览器设置中手动开启','error');
    return false;
  }
  var result=await Notification.requestPermission();
  if(result==='granted'){
    toast('通知权限已开启','success');
    return true;
  }
  toast('未授予通知权限','info');
  return false;
}
function notifyGenerationComplete(entry){
  if(!notificationsEnabled()||!entry)return;
  try{
    var title='';
    var body='';
    if(entry.status==='success'){
      title='图片生成完成';
      body='第'+entry.index+'张已生成完成 ('+(entry.model||'')+')';
      if(entry.images&&entry.images.length){
        body+='，共'+entry.images.length+'张';
      }
    }else if(entry.status==='error'){
      title='图片生成失败';
      body='第'+entry.index+'张失败: '+(entry.error||'未知错误');
    }else if(entry.status==='timeout'){
      title='图片生成超时';
      body='第'+entry.index+'张已超时，请检查上游服务';
    }else{
      return;
    }
    var n=new Notification(title,{
      body:body,
      icon:'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%236A5ACD"/><text x="32" y="42" font-size="36" text-anchor="middle" fill="white" font-family="sans-serif">AI</text></svg>',
      tag:'gen-'+entry.id,
      renotify:true
    });
    // 点击通知聚焦窗口
    n.onclick=function(){window.focus();n.close()};
    // 5 秒后自动关闭（部分浏览器会自动管理）
    setTimeout(function(){try{n.close()}catch(e){}},8000);
  }catch(e){
    console.warn('通知发送失败:',e.message);
  }
}

function generateUsername(){
  var firstNames=['emily','sarah','michael','david','jessica','james','ashley','chris','amanda','daniel','stephanie','joshua','nicole','andrew','samantha','ryan','lauren','justin','rachel','brandon','megan','tyler','katherine','kevin','elizabeth','brian','jennifer','jason','michelle','patrick','kimberly','travis','heather','nathan','courtney','maria','alex','lisa','robert','john'];
  var lastNames=['chen','wang','li','zhang','smith','johnson','lee','brown','garcia','martinez','wilson','taylor','thomas','moore','jackson','white','harris','clark','lewis','robinson','walker','young','allen','king','wright','scott','hill','green','adams','baker'];
  var adjectives=['happy','lucky','cool','sunny','swift','calm','bold','bright','dreamy','fresh','kind','wild','pure','warm','zen','chill','neon','cosmic','pixel','sage'];
  var nouns=['cat','fox','moon','star','sky','bear','wolf','deer','fish','hawk','tree','lake','rain','wave','wind','seed','leaf','snow','dawn','ray'];
  var fn=firstNames[Math.floor(Math.random()*firstNames.length)];
  var ln=lastNames[Math.floor(Math.random()*lastNames.length)];
  var adj=adjectives[Math.floor(Math.random()*adjectives.length)];
  var noun=nouns[Math.floor(Math.random()*nouns.length)];
  var pattern=Math.floor(Math.random()*5);
  var r2=Math.floor(10+Math.random()*90);
  var r3=Math.floor(100+Math.random()*900);
  var capitalize=function(s){return s.charAt(0).toUpperCase()+s.slice(1)};
  var sometimesCap=function(s){return Math.random()>0.5?capitalize(s):s};
  switch(pattern){
    case 0:return sometimesCap(fn)+'_'+sometimesCap(ln);
    case 1:return sometimesCap(fn)+sometimesCap(ln)+r2;
    case 2:return sometimesCap(fn)+r3;
    case 3:return adj+'_'+noun+r2;
    case 4:return sometimesCap(fn)+'.'+sometimesCap(ln)+r2;
    default:return fn+'_'+ln;
  }
}
function generatePassword(){var base=state.settings.defaultPassword||'Ml@2026Proxy';var d=new Date();var yy=String(d.getFullYear()).slice(-2);var mm=String(d.getMonth()+1).padStart(2,'0');var dd=String(d.getDate()).padStart(2,'0');return base+yy+mm+dd}

// ===== 链式邀请：获取上一个账号的邀请码 =====
async function getChainInviteCode(){
  // v0.7: keydraw.97api.com 共享 Gift Key 模式无邀请系统，链式邀请码不可用。
  return null;
}

// ===== 注册 (v0.1: 获取 Gift Key) =====
async function registerAccount(){
  // v1.0: 按当前通道分发
  var ch=effectiveChannel();
  if(ch==='maliang')return registerMaliangAccount();
  return registerKeydrawAccount();
}
// v1.0: keydraw 通道 —— 获取共享 Gift Key
async function registerKeydrawAccount(){
  // v0.1: keydraw.97api.com 不需要注册，直接 GET /api/gift-key 拿共享 key
  // 把它当作"账号"存进账号池：username = 'gift-key', password = '', sessionToken = <key>
  try{
    const r=await apiFetch('/gift-key',{});
    const d=await r.json();
    const key=d.key||'';
    if(!key)throw new Error('Gift Key 接口未返回 key');
    // 检查是否已存在
    if(state.accounts.some(a=>a.sessionToken===key)){
      toast('Gift Key 已在账号池中','info');
      return state.accounts.find(a=>a.sessionToken===key);
    }
    const a={
      username:'gift-key-'+key.substring(0,12),
      password:'',
      sessionToken:key,
      credits:9999,  // v0.1: keydraw 不暴露 credits，给个大数
      lastCheckinDay:'',
      lastCheckinTs:0,
      createdAt:Date.now(),
      disabled:false,
      userId:'',
      loginFailCount:0,
      lastLoginFailTs:0
    };
    state.accounts.push(a);
    if(state.activeAccountIndex<0)state.activeAccountIndex=0;
    saveState();renderAll();
    toast('已获取 Gift Key: '+key.substring(0,16)+'...','success');
    return a;
  }catch(e){
    // 后端代理未实现 /gift-key 时，使用 fallback key
    const key=CHANNELS.keydraw.giftKeyFallback;
    if(!state.accounts.some(a=>a.sessionToken===key)){
      const a={
        username:'gift-key-fallback',
        password:'',
        sessionToken:key,
        credits:9999,
        lastCheckinDay:'',
        lastCheckinTs:0,
        createdAt:Date.now(),
        disabled:false,
        userId:'',
        loginFailCount:0,
        lastLoginFailTs:0
      };
      state.accounts.push(a);
      if(state.activeAccountIndex<0)state.activeAccountIndex=0;
      saveState();renderAll();
      toast('使用内置 Gift Key (后端代理未实现 /gift-key)','info');
      return a;
    }
    return state.accounts.find(a=>a.sessionToken===key);
  }
}
// v1.0: maliang 通道 —— 用户名+密码注册（从 v27.2 移植）
async function registerMaliangAccount(){
  const u=generateUsername(),pw=generatePassword();
  var inviteCode=null;
  try{inviteCode=await getChainInviteCode()}catch(e){}
  if(inviteCode){toast('链式邀请: 使用 '+state.accounts[state.accounts.length-1].username+' 的邀请码注册','info')}
  const maxRetries=6;let lastErr='';
  for(let attempt=0;attempt<maxRetries;attempt++){
    try{
      if(attempt>0){const delay=500+Math.floor(Math.random()*1500);toast('第'+(attempt+1)+'次重试(换IP)...','info');await sleep(delay)}
      const r=await apiFetch('/auth/register',{method:'POST',body:JSON.stringify(Object.assign({username:u,password:pw},inviteCode?{inviteCode:inviteCode}:{}))});
      const d=await r.json();if(!r.ok)throw new Error(d.error||'注册失败: HTTP '+r.status);
      const st=r.headers.get('X-Session-Token')||'';
      const a={username:u,password:pw,sessionToken:st,credits:d.user?.imageCredits||3,lastCheckinDay:'',lastCheckinTs:0,createdAt:Date.now(),disabled:false,userId:d.user?.id||'',loginFailCount:0,lastLoginFailTs:0};
      state.accounts.push(a);if(state.activeAccountIndex<0)state.activeAccountIndex=0;
      saveState();renderAll();toast('马良注册成功: '+u+' ('+a.credits+'额度)','success');return a;
    }catch(e){lastErr=e.message;if(e.message.includes('已注册')&&attempt<maxRetries-1)continue;if(!e.message.includes('已注册'))break}
  }
  toast('马良自动注册失败: '+lastErr,'error');
  if(lastErr.includes('已注册')){toast('IP限制：当前网络今日已注册过账号，请稍后再试或手动添加账号','error')}
  throw new Error(lastErr);
}

// ===== 登录/签到/额度 =====
// v1.0: 按通道分发 —— keydraw gift-key 模式无需登录；maliang 走真实的 /auth/login
async function loginAccount(i){
  const a=state.accounts[i];if(!a)return;
  // v1.0: maliang 通道有真实登录
  if(effectiveChannel()==='maliang'){
    if(Date.now()<(a.cooldownUntil||0)){toast(a.username+' 登录冷却中，请等待'+Math.ceil(((a.cooldownUntil||0)-Date.now())/60000)+'分钟','info');throw new Error('登录冷却中')}
    try{
      const r=await apiFetch('/auth/login',{method:'POST',body:JSON.stringify({username:a.username,password:a.password})});
      const d=await r.json();
      if(!r.ok){const errMsg=d.error||'登录失败';if(errMsg.includes('用户名或密码错误')||errMsg.includes('Invalid credentials')){a.loginFailCount=(a.loginFailCount||0)+1;a.lastLoginFailTs=Date.now();a.cooldownUntil=Date.now()+300000;if(a.loginFailCount>=2){autoAbandonAccount(i,'连续登录失败');throw new Error(errMsg)}saveState();throw new Error(errMsg)}saveState();throw new Error(errMsg)}
      a.sessionToken=r.headers.get('X-Session-Token')||'';
      a.credits=d.user?.imageCredits||a.credits;
      a.lastCheckinDay=d.user?.lastCheckInDay||a.lastCheckinDay;
      a.userId=d.user?.id||a.userId;
      a.loginFailCount=0;a.lastLoginFailTs=0;a.cooldownUntil=0;
      saveState();renderAll();return d;
    }catch(e){console.warn('登录'+a.username+'失败:',e.message);throw e}
  }
  // v0.1: keydraw gift-key 模式无需登录
  if(!a.sessionToken)throw new Error('账号无 sessionToken');
  a.loginFailCount=0;a.lastLoginFailTs=0;a.cooldownUntil=0;saveState();renderAll();return {user:{imageCredits:a.credits||9999}}
}
// v24: 上游 grok.17nas.com 已下线签到功能，/account/checkin 接口返回 "接口不存在"
// 保留函数签名以维持兼容性，但立即返回友好错误信息，不再调用已失效的上游接口
async function checkinAccount(i){const a=state.accounts[i];if(!a){return}const friendlyMsg='v0.1: keydraw 上游无签到概念（共享 Gift Key 模式），请使用刷新额度或重新获取 Gift Key';toast(a.username+' '+friendlyMsg,'info');throw new Error(friendlyMsg)}

// v25: 自动废弃账号 - 将余额不足的账号从活跃池移入废弃池
// 签到下线后，余额不足（< 当前模型单张成本）的账号无法恢复，一次性即抛
function autoAbandonAccount(accountIndex,reason){
  if(accountIndex<0||accountIndex>=state.accounts.length)return false;
  var acc=state.accounts[accountIndex];
  if(!acc)return false;
  if(!state.abandonedAccounts)state.abandonedAccounts=[];
  // 已在废弃池则跳过
  if(state.abandonedAccounts.some(a=>a.username===acc.username))return false;
  var abandoned={
    username:acc.username,
    password:acc.password,
    abandonedAt:Date.now(),
    reason:reason||'余额不足',
    credits:acc.credits||0,
    sessionToken:acc.sessionToken||'',
    userId:acc.userId||'',
    loginFailCount:acc.loginFailCount||0,
    lastLoginFailTs:acc.lastLoginFailTs||0
  };
  state.abandonedAccounts.push(abandoned);
  state.accounts.splice(accountIndex,1);
  if(state.activeAccountIndex>=state.accounts.length){
    state.activeAccountIndex=Math.max(0,state.accounts.length-1);
  }
  // 从已耗尽集合中也标记（防止后续 selectAccount 误选）
  exhaustedAccounts.add(acc.username);
  return true;
}

// v25: 刷新额度 - 检测余额不足时自动移入废弃池
async function refreshQuota(i){
  const a=state.accounts[i];if(!a)return;
  if(!a.sessionToken)try{await loginAccount(i)}catch(e){return}
  const acc=state.accounts[i];
  try{
    // v0.1: keydraw 无 /account/quota 端点，直接返回 9999
    const d={user:{imageCredits:9999}};
    const r={ok:true,json:()=>Promise.resolve(d)};
    if(false){
      if(isAuthError(d.error)||(d.error&&(d.error.includes('token')||d.error.includes('session')||d.error.includes('登录')||d.error.includes('expired')))){
        acc.sessionToken='';saveState();renderAll()
      }
      throw new Error(d.error||'查询额度失败');
    }
    acc.credits=d.user?.imageCredits??acc.credits;
    acc.lastCheckinDay=d.checkIn?.today||acc.lastCheckinDay;
    if(d.storage){storageCache.set(acc.username,d.storage)}
    // v25: 余额不足以生成 1 张图（按当前模型/档位）→ 自动移入废弃池
    var model=getCurrentModel(),tier=getCurrentTier();
    if(!canGenerateAtLeastOne(acc.credits,model,tier)&&acc.credits<getCreditsPerImage(model,tier)){
      // 注意：这里用当前模型判断，如果用户切换模型可能复苏，但通常余额不足就是不足
      // 仅当 credits 严格小于单张成本时才废弃（避免误判）
      if(acc.credits<getCreditsPerImage('gpt-image-2','standard')){
        // 即使最便宜的 gpt-image-2 standard(3 credits) 都不够 → 确认废弃
        autoAbandonAccount(i,'余额不足（'+acc.credits+' credits，无法生成）');
        toast(acc.username+' 余额仅 '+acc.credits+'，已移入废弃池','info');
        saveState();renderAll();renderAccountsTable();
        return d;
      }
    }
    saveState();renderAll();renderStorageInfo();return d;
  }catch(e){toast('查询'+acc.username+'额度失败','error')}
}

// v25: 批量清理无余额账号 - 手动触发，扫描所有账号并将余额不足的移入废弃池
async function cleanupInsufficientAccounts(){
  if(!state.accounts.length){toast('暂无账号','info');return}
  toast('正在扫描账号余额...','info');
  var abandonedN=0,checkedN=0;
  // 先刷新所有账号的额度
  for(let i=0;i<state.accounts.length;i++){
    if(!state.accounts[i].disabled&&state.accounts[i].sessionToken){
      try{await refreshQuota(i);checkedN++}catch(e){}
      await sleep(300);
    }
  }
  // 再扫描移入废弃池（refreshQuota 内部可能已经移了一部分）
  // 注意：refreshQuota 后 index 会变化，需要倒序遍历
  for(let i=state.accounts.length-1;i>=0;i--){
    var acc=state.accounts[i];
    if(!acc||acc.disabled)continue;
    var model=getCurrentModel(),tier=getCurrentTier();
    if(acc.credits<getCreditsPerImage('gpt-image-2','standard')){
      // 连最便宜的 gpt-image-2 standard 都不够 → 废弃
      if(autoAbandonAccount(i,'清理：余额仅 '+acc.credits+' credits')){
        abandonedN++;
      }
    }
  }
  saveState();renderAll();renderAccountsTable();
  toast('扫描完成：检查 '+checkedN+' 个账号，移入废弃池 '+abandonedN+' 个','success');
}


// ===== 媒体存储配额 =====
function renderStorageInfo(){
  var c=document.getElementById('storageInfoContainer');
  if(!c)return;
  var entries=[];
  storageCache.forEach(function(v,k){entries.push({username:k,...v})});
  if(!entries.length){c.innerHTML='';return}
  var html='<div style="border-top:1px solid var(--bg4);padding-top:12px;margin-top:4px">';
  html+='<span style="font-size:.85rem;font-weight:600;color:var(--fg2)">媒体存储</span>';
  entries.forEach(function(e){
    var usageMb=(e.mediaUsageBytes||0)/(1024*1024);
    var quotaMb=e.mediaQuotaMb||0;
    var pct=e.usagePercent||0;
    var color='var(--fg2)';
    if(pct>=95)color='var(--red)';
    else if(pct>=85)color='var(--orange)';
    else if(pct>=70)color='var(--orange)';
    html+='<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:.8rem">';
    html+='<span style="color:var(--fg3)">'+escHtml(e.username)+'</span>';
    html+='<span style="color:'+color+'">媒体存储: '+usageMb.toFixed(1)+' / '+quotaMb+' MB \\u00B7 '+pct.toFixed(1)+'%</span>';
    if(pct>=70){
      html+='<button class="btn btn-xs" onclick="cleanupStorage(\\''+escHtml(e.username)+'\\')">清理旧媒体</button>';
    }
    html+='</div>';
  });
  html+='</div>';
  c.innerHTML=html;
}
async function cleanupStorage(username){
  var acc=state.accounts.find(function(a){return a.username===username});
  if(!acc||!acc.sessionToken){toast('账号未登录','error');return}
  try{
    toast('正在清理 '+username+' 的旧媒体...','info');
    var r=await apiFetch('/account/storage/cleanup',{method:'POST',body:JSON.stringify({pruneHistory:true,removeMedia:false}),_sessionToken:acc.sessionToken});
    var d=await r.json();
    if(!r.ok)throw new Error(d.error||'清理失败');
    toast(username+' 清理完成','success');
    var idx=state.accounts.indexOf(acc);
    if(idx>=0)await refreshQuota(idx);
  }catch(e){toast('清理失败: '+e.message,'error')}
}

// ===== 邀请中心 =====
async function showInvitePanel(){
  // v0.7: keydraw.97api.com 无 /account/invite 端点（共享 Gift Key 模式，无邀请系统）。
  //       保留 UI 入口但提示用户此功能在上游不可用，避免点击后产生 404 噪声。
  toast('当前上游 keydraw.97api.com 为共享 Gift Key 模式，无邀请系统。如需更多额度请刷新 Gift Key 或注册新 key。','info');
  return;
}
function closeInvitePanel(){document.getElementById('invitePanelContainer').style.display='none'}
function copyInviteLink(){
  var el=document.getElementById('inviteLinkInput');
  if(!el.value){toast('暂无邀请链接','info');return}
  navigator.clipboard.writeText(el.value).then(function(){toast('邀请链接已复制','success')}).catch(function(){toast('复制失败','error')});
}

async function autoRegister(){await registerAccount()}
async function addManualAccount(){const u=prompt('请输入用户名:');if(!u||!u.trim())return;const pw=prompt('请输入密码:');if(!pw||!pw.trim())return;const username=u.trim(),password=pw.trim();if(state.accounts.some(a=>a.username===username)){toast('该用户名已存在','error');return}state.accounts.push({username,password,sessionToken:'',credits:0,lastCheckinDay:'',lastCheckinTs:0,createdAt:Date.now(),disabled:false,userId:'',loginFailCount:0,lastLoginFailTs:0});if(state.activeAccountIndex<0)state.activeAccountIndex=0;saveState();renderAll();toast('账号已添加，正在登录...','success');try{await loginAccount(state.accounts.length-1);await refreshQuota(state.accounts.length-1)}catch(e){toast('登录失败，请检查账号密码','error')}}
// v24: 上游已下线签到功能，批量签到按钮提示用户使用替代方案
async function checkinAll(){toast('上游已下线签到功能，无法批量签到。建议改用「刷新额度」或「注册新账号」获取额度','info');return}
async function refreshAllQuota(){if(!state.accounts.length){toast('暂无账号','info');return}toast('正在刷新额度...','info');for(let i=0;i<state.accounts.length;i++){if(!state.accounts[i].disabled){await refreshQuota(i);await sleep(400)}}toast('额度刷新完成','success')}
async function batchVerifyAccounts(){if(!state.accounts.length){toast('暂无账号','info');return}toast('开始批量验证(只读额度查询)...','info');var okN=0,deadN=0,coolN=0;for(var i=0;i<state.accounts.length;i++){var a=state.accounts[i];if(a.disabled)continue;if(Date.now()<(a.cooldownUntil||0)){coolN++;continue}if(!a.sessionToken){try{await loginAccount(i);okN++}catch(e){deadN++}await sleep(300);continue}try{var r={ok:true,json:()=>Promise.resolve({user:{imageCredits:a.credits||9999}})};if(r.ok){okN++;var d=await r.json();a.credits=d.user?.imageCredits??a.credits;saveState();renderAll()}else{a.sessionToken='';saveState();try{await loginAccount(i);okN++}catch(e){deadN++}}}catch(e){a.sessionToken='';saveState();try{await loginAccount(i);okN++}catch(e2){deadN++}}await sleep(500)}renderAccountsTable();toast('验证完成: '+okN+'个可用'+(deadN?'，'+deadN+'个失效':'')+(coolN?'，'+coolN+'个冷却中':''),okN>0?'success':'error')}

// ===== 账号选择 =====
// v25: 账号选择改用"可生成至少 1 张图"判断（替代原来的 credits>0）
function getCurrentModel(){return document.getElementById('modelSelect')?document.getElementById('modelSelect').value:'gpt-image-2'}
function getCurrentTier(){return selectedQualityTier||'standard'}
function selectAccount(){const model=getCurrentModel(),tier=getCurrentTier();const avail=state.accounts.map((a,i)=>({...a,_i:i})).filter(a=>!a.disabled&&a.sessionToken&&canGenerateAtLeastOne(a.credits,model,tier));if(!avail.length)return null;switch(state.settings.rotationStrategy){case'most-credits':avail.sort((a,b)=>creditsToImageCount(b.credits,model,tier)-creditsToImageCount(a.credits,model,tier));return avail[0];case'round-robin':state.rotationIndex=state.rotationIndex%avail.length;const p=avail[state.rotationIndex];state.rotationIndex++;saveState();return p;case'newest':avail.sort((a,b)=>b.createdAt-a.createdAt);return avail[0];default:return avail[0]}}
// v24: 跳过 autoCheckin 分支（上游已下线签到功能），改为直接进入注册流程
async function ensureAccount(){let a=selectAccount();if(a)return a;for(let i=0;i<state.accounts.length;i++){if(!state.accounts[i].disabled&&!state.accounts[i].sessionToken)try{await loginAccount(i)}catch(e){}}a=selectAccount();if(a)return a;const totalCredits=state.accounts.filter(a=>!a.disabled).reduce((s,a)=>s+(a.credits||0),0);if(totalCredits<=0){toast('所有账号额度为0，正在自动注册新账号...','info')}if(state.settings.autoRegister){try{await registerAccount()}catch(e){return null}a=selectAccount();if(a)return a}return null}

// 排除已耗尽账号的账号选择
// v25: 排除已耗尽账号的账号选择 - 使用 canGenerateAtLeastOne
function selectAccountWithExclude(excludeSet){const model=getCurrentModel(),tier=getCurrentTier();const avail=state.accounts.map((a,i)=>({...a,_i:i})).filter(a=>!a.disabled&&a.sessionToken&&canGenerateAtLeastOne(a.credits,model,tier)&&!excludeSet.has(a.username));if(!avail.length)return null;switch(state.settings.rotationStrategy){case'most-credits':avail.sort((a,b)=>creditsToImageCount(b.credits,model,tier)-creditsToImageCount(a.credits,model,tier));return avail[0];case'round-robin':state.rotationIndex=state.rotationIndex%avail.length;const p=avail[state.rotationIndex];state.rotationIndex++;saveState();return p;case'newest':avail.sort((a,b)=>b.createdAt-a.createdAt);return avail[0];default:return avail[0]}}
// v24: 跳过 autoCheckin 分支（上游已下线签到功能）
async function ensureAccountWithExclude(excludeSet){let a=selectAccountWithExclude(excludeSet);if(a)return a;// 尝试登录未登录的账号(排除已耗尽的)
for(let i=0;i<state.accounts.length;i++){if(!state.accounts[i].disabled&&!state.accounts[i].sessionToken&&!excludeSet.has(state.accounts[i].username))try{await loginAccount(i)}catch(e){}}a=selectAccountWithExclude(excludeSet);if(a)return a;if(state.settings.autoRegister){try{await registerAccount()}catch(e){return null}a=selectAccountWithExclude(excludeSet);if(a)return a}return null}

// ===== 并发生成 =====
// v25: 并发数按"可生成至少 1 张图"的账号数计算
function maxConcurrency(){const model=getCurrentModel(),tier=getCurrentTier();return state.accounts.filter(a=>!a.disabled&&a.sessionToken&&canGenerateAtLeastOne(a.credits,model,tier)).length*CONCURRENT_PER_ACCOUNT}
function availableSlots(){return Math.max(0,maxConcurrency()-activeSlots)}
function isGptImgInner(m){return m==='gpt-image-2'||m==='grok-imagine-image-edit'}
function isVideoModelInner(m){return m==='grok-imagine-video'}
function isGrokImgModel(m){return m==='grok-imagine-image'||m==='grok-imagine-image-pro'||m==='grok-imagine-image-lite'||m==='grok-imagine-image-edit'}
function supportsRefImageInner(m){return isGptImgInner(m)||isVideoModelInner(m)}

// ===== 画质档位 & 视频清晰度 =====
var TIER_LONGEST={standard:1536,high:2560,ultra:3840};
var TIER_SQUARE={standard:1024,high:2048,ultra:2816};
var PIXEL_BUDGET=8294400;
var ALIGN=64;
var TIER_LABEL={standard:'1.5K',high:'2.5K',ultra:'4K'};
var TIER_PRICE={standard:'¥0.2',high:'¥0.3',ultra:'¥2.0'};

// ===== v25: 计费模型 (credits-based, 1 credit = ¥0.1) =====
// 上游仍在用 imageCredits 字段记账，但签到下线后老账号余额无法补充，一次性即抛
// 各模型/档位单张所需 credits（来自上游 system 配置）
var GPT2_TIER_CREDITS={standard:3,high:8,ultra:30};
var MODEL_CREDITS={
  'grok-imagine-image-lite':0.2,
  'grok-imagine-image':0.4,
  'grok-imagine-image-edit':0.4,
  'grok-imagine-image-pro':1
};
// 视频模型：每秒 credits
var VIDEO_CREDITS_PER_SEC={'grok-imagine-video':1};

// 获取指定模型/档位下单张图片所需 credits
function getCreditsPerImage(model,tier){
  if(model==='gpt-image-2'){
    return GPT2_TIER_CREDITS[tier||'standard']||3;
  }
  if(MODEL_CREDITS[model]){
    return MODEL_CREDITS[model];
  }
  return 3; // 默认按 gpt-image-2 standard
}

// 将 credits 转换为可生成图片数（向下取整）
function creditsToImageCount(credits,model,tier){
  if(!credits||credits<=0)return 0;
  var cost=getCreditsPerImage(model,tier);
  if(cost<=0)return 0;
  return Math.floor(credits/cost);
}

// 判断账号余额是否足以生成至少 1 张图（按当前模型/档位）
function canGenerateAtLeastOne(credits,model,tier){
  return credits>=getCreditsPerImage(model,tier);
}

function calcGptImage2Size(ratio,tier){
  if(ratio==='auto'||ratio==='1:1'){
    return TIER_SQUARE[tier]+'x'+TIER_SQUARE[tier];
  }
  var parts=ratio.split(':');
  var rLong=parseInt(parts[0]),rShort=parseInt(parts[1]);
  var isWide=rLong>=rShort;
  var longE=TIER_LONGEST[tier];
  var shortE=Math.round(longE*(isWide?rShort:rLong)/(isWide?rLong:rShort)/ALIGN)*ALIGN;
  if(shortE<512)shortE=512;
  if(longE*shortE>PIXEL_BUDGET){
    var scale=Math.sqrt(PIXEL_BUDGET/(longE*shortE));
    longE=Math.round(longE*scale/ALIGN)*ALIGN;
    shortE=Math.round(shortE*scale/ALIGN)*ALIGN;
    if(shortE<512)shortE=512;
  }
  return (isWide?longE:shortE)+'x'+(isWide?shortE:longE);
}

function getGrokSize(r){
  if(r==='auto')r='1:1';
  var grokMap={
    '1:1':'1024x1024',
    '16:9':'1280x720','2:1':'1280x720','21:9':'1280x720',
    '9:16':'720x1280','1:2':'720x1280','9:21':'720x1280',
    '3:2':'1792x1024','4:3':'1792x1024','5:4':'1792x1024',
    '2:3':'1024x1792','3:4':'1024x1792','4:5':'1024x1792'
  };
  return grokMap[r]||'1024x1024';
}

function getEffectiveSize(model,ratio,tier){
  if(model==='grok-imagine-image-lite')return '784x1168';
  if(isGrokImgModel(model))return getGrokSize(ratio);
  if(isVideoModelInner(model))return getGrokSize(ratio);
  if(model==='gpt-image-2')return calcGptImage2Size(ratio,tier||'standard');
  return getGptSizeLegacy(ratio);
}

function getGptSizeLegacy(r){
  if(r==='auto')return null;
  r=r||'1:1';
  var sizeMap={
    '1:1':'1024x1024',
    '3:2':'1536x1024','2:3':'1024x1536',
    '16:9':'1792x1024','9:16':'1024x1792',
    '4:3':'1536x1152','3:4':'1152x1536',
    '5:4':'1280x1024','4:5':'1024x1280',
    '2:1':'1792x896','1:2':'896x1792',
    '21:9':'1792x768','9:21':'768x1792'
  };
  return sizeMap[r]||'1024x1024';
}

function onRatioChange(){
  var sel=document.getElementById('ratioSelect');
  if(sel)selectedRatio=sel.value;
  var model=document.getElementById('modelSelect').value;
  if(model==='gpt-image-2'){updateQualityTierHint()}
  updateGrokSizeHint();
}

function toggleOngoingFilter(){
  var chk=document.getElementById('ongoingChk');
  var showOngoing=chk&&chk.checked;
  document.querySelectorAll('.hist-item').forEach(function(el){
    if(!showOngoing){el.style.display='';return}
    var isRunning=el.classList.contains('running-item');
    el.style.display=isRunning?'':'none';
  });
}

function onQualityTierChange2(){
  var sel=document.getElementById('qualityTierSelect2');
  if(sel){selectedQualityTier=sel.value;var mainSel=document.getElementById('qualityTierSelect');if(mainSel)mainSel.value=sel.value}
  updateQualityTierHint();
}

function onQualityTierChange(){
  selectedQualityTier=document.getElementById('qualityTierSelect').value;
  var sel2=document.getElementById('qualityTierSelect2');if(sel2)sel2.value=selectedQualityTier;
  updateQualityTierHint();
  // v25: 档位变化时刷新 topbar 和账号表
  renderTopbar();
  updateConcurrencyUI();
  if(document.getElementById('settingsModal').classList.contains('show')){
    renderAccountsTable();
  }
}
function updateQualityTierHint(){
  var model=document.getElementById('modelSelect').value;
  var tier=selectedQualityTier;
  var sizeStr=calcGptImage2Size(selectedRatio,tier);
  document.getElementById('qualityTierHint').textContent=TIER_LABEL[tier]+'\\u00B7'+sizeStr+'\\u00B7'+TIER_PRICE[tier]+'/张';
}
function onVideoResolutionChange(){
  selectedVideoResolution=document.getElementById('videoResolutionSelect').value;
}
function updateGrokSizeHint(){
  var model=document.getElementById('modelSelect').value;
  var hintGroup=document.getElementById('grokSizeHintGroup');
  var hintEl=document.getElementById('grokSizeHintText');
  if(model==='grok-imagine-image-lite'){
    hintGroup.style.display='block';
    hintEl.textContent='lite 模型上游仅支持 2:3 \\u00B7 784\\u00D71168';
  }else if(isGrokImgModel(model)||isVideoModelInner(model)){
    hintGroup.style.display='block';
    var sz=getGrokSize(selectedRatio);
    hintEl.textContent='Grok 上游尺寸: '+sz;
  }else{
    hintGroup.style.display='none';
  }
}

// v0.4: keydraw requires client_task_id in format: timestamp-randomhex
//       (e.g. 1783440890123-3d70ac176c97). Other formats are silently
//       rejected with misleading error '生成数量只能是 1、2、3、4'.
function genClientTaskId(){return Date.now()+'-'+Math.random().toString(16).slice(2)}
async function startGeneration(){
  const prompt=document.getElementById('promptInput').value.trim();
  if(!prompt){toast('请输入提示词','error');return}
  const model=document.getElementById('modelSelect').value;
  // Model availability pre-check
  if(model==='grok-imagine-video'&&modelAvailability.videoAvailable===false){toast(modelAvailability.videoError||'视频模型已临时下架，暂不可用','error');return}
  const count=parseInt(document.getElementById('countSelect').value)||1;
  const size=getEffectiveSize(model,selectedRatio,selectedQualityTier);
  const hasRef=refImages.length>0&&supportsRefImageInner(model);
  const currentRefImages=[...refImages];
  const isVideo=isVideoModelInner(model);
  const duration=isVideo?parseInt(document.getElementById('durationSelect').value)||6:null;
  const currentQualityTier=(model==='gpt-image-2')?selectedQualityTier:null;
  const currentResolution=isVideo?selectedVideoResolution:null;
  const btn=document.getElementById('generateBtn');btn.disabled=true;btn.textContent='提交中...';setTimeout(()=>{btn.disabled=false;btn.textContent='生成图片'},500);
  const entries=[];
  for(let i=0;i<count;i++){const entry={id:Date.now().toString(36)+'_'+i,prompt,model,ratio:selectedRatio,count,index:i+1,timestamp:Date.now(),status:'queued',images:[],error:'',account:'',progress:0,progressText:'排队中',startedAt:0,isVideo:isVideo,duration:duration};entries.push(entry);taskStartTimes.set(entry.id,Date.now());addHistory(entry)}
  toast(count+'个任务已加入队列','info');
  (async()=>{let submitted=0;while(submitted<entries.length){while(availableSlots()<=0){await sleep(500)}const entry=entries[submitted];submitted++;activeSlots++;updateConcurrencyUI();executeTask(entry,model,prompt,size,hasRef,currentRefImages,isVideo,duration,currentQualityTier,currentResolution).finally(()=>{activeSlots--;updateConcurrencyUI()});await sleep(300)}})();
}

// 额度不足时自动换号：记录已试过的账号，避免重复
let exhaustedAccounts=new Set();

async function executeTaskOnChannel(entry,model,prompt,size,hasRef,currentRefImages,isVideo,duration,qualityTier,resolutionName){
  let retryCount=0;const maxRetries=3;
  while(retryCount<=maxRetries){
    let authRetriedThisIteration=false; // v24: 本次循环是否已尝试过自动重新登录
    try{
      const acc=await ensureAccountWithExclude(exhaustedAccounts);
      if(!acc){entry.status='error';entry.error='所有账号余额不足，请注册新账号或充值';entry.progressText='失败';updateHistory(entry.id,{status:entry.status,error:entry.error,progressText:entry.progressText});toast(entry.error,'error');notifyGenerationComplete(entry);return}
      entry.account=acc.username;entry.status='running';entry.progressText='提交任务中...';entry.progress=5;entry.startedAt=Date.now();taskStartTimes.set(entry.id,entry.startedAt);
      updateHistory(entry.id,{status:entry.status,account:entry.account,progressText:entry.progressText,progress:entry.progress,startedAt:entry.startedAt});
      // v0.1: keydraw.97api.com API
      // 文生图: POST /api/image-tasks/generations  body={client_task_id, prompt, model, size, quality}
      // 图生图: POST /api/image-tasks/edits  multipart: image, client_task_id, prompt, model, size, quality
      // v0.4: 用 keydraw 要求的格式生成 client_task_id（不能用 entry.id，因含下划线被上游拒绝）
      const clientTaskId=entry.clientTaskId||(entry.clientTaskId=genClientTaskId());
      let r;
      if(hasRef && currentRefImages && currentRefImages.length){
        // 图生图 - multipart form
        const fd=new FormData();
        currentRefImages.forEach((img,idx)=>{
          // img.dataUrl is data URL; convert to Blob
          const arr=img.dataUrl.split(',');
          const mime=arr[0].match(/:(.*?);/)[1];
          const bstr=atob(arr[1]);
          const u8=new Uint8Array(bstr.length);
          for(let i=0;i<bstr.length;i++)u8[i]=bstr.charCodeAt(i);
          fd.append('image', new Blob([u8],{type:mime}), img.name||('ref_'+idx+'.png'));
        });
        fd.append('client_task_id', clientTaskId);
        fd.append('prompt', prompt);
        fd.append('model', model);
        if(size) fd.append('size', size);
        fd.append('quality', 'auto');
        fd.append('n', '1');  // v1.0: keydraw edits 端点也需要 n 参数，否则返回误导性 "生成数量只能是 1、2、3、4"
        r=await apiFetchMultipart('/image-tasks/edits', fd, acc.sessionToken);
      } else {
        // 文生图 - JSON
        const body={client_task_id:clientTaskId, prompt, model, quality:'auto'};
        if(size) body.size=size;
        r=await apiFetch('/image-tasks/generations',{method:'POST',body:JSON.stringify(body),_sessionToken:acc.sessionToken});
      }
      const d=await r.json();if(!r.ok){const errMsg=d.error||d.message||d.detail?.error?.message||d.detail||'创建任务失败';
        // v24: 检测会话过期("请先登录"等)，自动重新登录并重试本次请求
        if(isAuthError(errMsg)&&!authRetriedThisIteration){
          authRetriedThisIteration=true;
          toast(acc.username+' 会话已过期，正在自动重新登录...','info');
          var newToken=await tryRelogin(findAccountIndexByUsername(acc.username));
          if(newToken){continue}
          // 重新登录失败，继续走错误流程
        }
        // v25: 额度/余额不足 → 自动移入废弃池（一次性即抛），换号重试
        if(errMsg.includes('insufficient_quota')||errMsg.includes('额度不足')||errMsg.includes('余额不足')){
          exhaustedAccounts.add(acc.username);
          var ai2=state.accounts.findIndex(a=>a.username===acc.username);
          if(ai2>=0){
            state.accounts[ai2].credits=0;
            // v25: 自动移入废弃池（签到已下线，余额不足的账号无法恢复）
            autoAbandonAccount(ai2,'余额不足（'+errMsg.substring(0,40)+'）');
            saveState();renderAll();renderAccountsTable();
          }
          toast(acc.username+' 余额不足，已移入废弃池，自动换号中...','info');
          retryCount++;entry.progressText='余额不足，换号重试 ('+retryCount+'/'+maxRetries+')';entry.progress=0;
          updateHistory(entry.id,{status:'queued',progressText:entry.progressText,progress:entry.progress});
          await sleep(800);continue;
        }
        throw new Error(errMsg)}
      // 成功提交，清除已耗尽记录
      exhaustedAccounts.clear();
      const ai=state.accounts.findIndex(a=>a.username===acc.username);if(ai>=0&&d.user){state.accounts[ai].credits=d.user.imageCredits??state.accounts[ai].credits;saveState();renderAll()}
      const tid=d.id;if(!tid)throw new Error('未返回任务ID');  // v0.1: keydraw returns {id:'...'}
      entry.progressText='任务已提交，等待生成...';entry.progress=10;updateHistory(entry.id,{progressText:entry.progressText,progress:entry.progress});
      const res=await pollTask(tid,acc.sessionToken,entry);
      if(res){entry.status='success';entry.images=res.images;entry.progress=100;entry.progressText='生成完成';updateHistory(entry.id,{status:entry.status,images:entry.images,progress:entry.progress,progressText:entry.progressText});notifyGenerationComplete(entry);return}
    }catch(e){const errMsg=extractErrorMessage(e.message);if(retryCount<maxRetries){retryCount++;entry.status='running';entry.progressText='失败，准备重试 ('+retryCount+'/'+maxRetries+')';entry.progress=0;updateHistory(entry.id,{status:entry.status,progressText:entry.progressText,progress:entry.progress});await sleep(1500);continue}entry.status=errMsg.includes('超时')?'timeout':'error';entry.error=errMsg;entry.progressText='失败';updateHistory(entry.id,{status:entry.status,error:entry.error,progressText:entry.progressText});toast('第'+entry.index+'张失败: '+errMsg,'error');notifyGenerationComplete(entry);
      // Auto-fallback to gpt-image-2 if enabled and model is not gpt-image-2
      if(state.settings.autoFallbackGpt2 && model !== 'gpt-image-2' && entry.status !== 'success') {
        var fallbackModel = 'gpt-image-2';
        var fallbackSize = calcGptImage2Size(selectedRatio, 'standard');
        entry.progressText = '换用 GPT-Image-2 重试中...';
        entry.progress = 0;
        updateHistory(entry.id, {status:'queued', progressText:entry.progressText, progress:entry.progress});
        toast('原模型失败，自动换用 GPT-Image-2 重试', 'info');
        var savedModel = model;
        model = fallbackModel;
        retryCount = 0;
        while(retryCount <= maxRetries) {
          try {
            const acc = await ensureAccountWithExclude(exhaustedAccounts);
            if(!acc) break;
            entry.account = acc.username;
            entry.status = 'running';
            entry.progressText = 'GPT-Image-2 生成中...';
            entry.progress = 5;
            entry.startedAt = Date.now();
            taskStartTimes.set(entry.id, entry.startedAt);
            updateHistory(entry.id, {status:entry.status, account:entry.account, progressText:entry.progressText, progress:entry.progress, startedAt:entry.startedAt});
            const body = {model:fallbackModel, prompt, n:1, response_format:'b64_json', endpointKind:'generations', attachments:[], qualityTier:'standard'};
            if(fallbackSize) body.size = fallbackSize;
            if(selectedRatio !== 'auto') body.requestAspectRatio = selectedRatio;
            const r = await apiFetch('/proxy/image-tasks', {method:'POST', body:JSON.stringify(body), _sessionToken:acc.sessionToken});
            const d = await r.json();
            if(!r.ok) {
              // v24: 检测会话过期，尝试重新登录后继续重试
              var fbErrMsg=d.error||d.message||'创建任务失败';
              if(isAuthError(fbErrMsg)){
                toast(acc.username+' 会话已过期，正在自动重新登录...','info');
                var fbNewToken=await tryRelogin(findAccountIndexByUsername(acc.username));
                if(fbNewToken){continue}
              }
              throw new Error(fbErrMsg);
            }
            exhaustedAccounts.clear();
            const ai=state.accounts.findIndex(a=>a.username===acc.username);
            if(ai>=0&&d.user){state.accounts[ai].credits=d.user.imageCredits??state.accounts[ai].credits;saveState();renderAll()}
            const tid=d.task?.id;
            if(!tid) throw new Error('未返回任务ID');
            entry.progressText='任务已提交，等待生成...';entry.progress=10;
            updateHistory(entry.id,{progressText:entry.progressText,progress:entry.progress});
            const res=await pollTask(tid,acc.sessionToken,entry);
            if(res){entry.status='success';entry.images=res.images;entry.progress=100;entry.progressText='生成完成(GPT-Image-2回退)';updateHistory(entry.id,{status:entry.status,images:entry.images,progress:entry.progress,progressText:entry.progressText});notifyGenerationComplete(entry);return}
          } catch(e2) {
            if(retryCount < maxRetries){retryCount++;await sleep(1500);continue}
            break;
          }
        }
        model = savedModel;
        // v24: 回退失败也发通知
        entry.status=entry.status==='success'?'success':'error';
        if(entry.status!=='success'){notifyGenerationComplete(entry)}
      }
      return}
  }
}

// v1.0: executeTask 包装层 —— 处理 'auto' 模式下的通道故障切换
// 原始执行逻辑见 executeTaskOnChannel（单通道）
async function executeTask(entry,model,prompt,size,hasRef,currentRefImages,isVideo,duration,qualityTier,resolutionName){
  if(state.activeChannel!=='auto'){
    // 固定通道模式：直接调用单通道版本
    return executeTaskOnChannel(entry,model,prompt,size,hasRef,currentRefImages,isVideo,duration,qualityTier,resolutionName);
  }
  // 'auto' 模式：先试 lastChannel，硬失败则切换到另一通道重试一次
  // 硬失败判定：executeTaskOnChannel 抛出不可恢复错误（网络错误、5xx、submit 失败）
  // 注意：余额不足/会话过期不算硬失败（这些会在 executeTaskOnChannel 内部自动换号/重登）
  var firstChannel=state.lastChannel||'keydraw';
  var otherChannel=(firstChannel==='keydraw')?'maliang':'keydraw';
  // 切到第一通道
  state.lastChannel=firstChannel;syncAccountsToActiveChannel();
  try{
    await ensureChannelReady();
    return await executeTaskOnChannel(entry,model,prompt,size,hasRef,currentRefImages,isVideo,duration,qualityTier,resolutionName);
  }catch(e){
    // 第一通道硬失败 —— 切换到另一通道，把参考图等附件一并带过去
    var errMsg=e.message||String(e);
    // 仅对真正的"硬失败"切换：网络错误、上游 5xx、submit 阶段失败
    // 不切换的情况：用户主动取消、内容政策违规（换通道也一样会被拒）
    if(errMsg.includes('内容违反政策')||errMsg.includes('content_policy')||errMsg.includes('safety')){
      throw e;  // 内容违规不切换
    }
    toast(firstChannel+' 通道失败 ('+errMsg.substring(0,60)+')，自动切换到 '+otherChannel+' 重试','info');
    entry.progressText='切换到 '+otherChannel+' 通道重试中...';entry.progress=0;
    updateHistory(entry.id,{status:'queued',progressText:entry.progressText,progress:entry.progress});
    state.lastChannel=otherChannel;syncAccountsToActiveChannel();
    try{
      await ensureChannelReady();
      return await executeTaskOnChannel(entry,model,prompt,size,hasRef,currentRefImages,isVideo,duration,qualityTier,resolutionName);
    }catch(e2){
      // 两通道都失败 —— 还原 lastChannel 到第一通道（避免下次启动用坏通道）
      state.lastChannel=firstChannel;syncAccountsToActiveChannel();saveState();
      throw e2;
    }
  }
}

// v25: 更新错误消息，移除"签到"相关提示
function extractErrorMessage(raw){var msg=raw||'未知错误';if(msg.includes('上游图片接口返回失败')||msg.includes('上游')&&msg.includes('失败'))return msg;if(msg.includes('临时下架')||msg.includes('暂不开放'))return'视频模型已临时下架，暂不可用';if(msg.includes('not an image model'))return'视频模型API端点错误，请更新版本';if(msg.includes('content_policy')||msg.includes('policy')||msg.includes('safety'))return'内容违反政策(OpenAI安全策略限制)';if(msg.includes('rate_limit'))return'请求频率超限，请稍后再试';if(msg.includes('insufficient_quota')||msg.includes('额度不足')||msg.includes('余额不足'))return'账户余额不足，请注册新账号或充值';if(msg.includes('超时')||msg.includes('timeout'))return msg;if(msg.includes('已注册'))return'当前IP今日已注册过账号';if(msg.includes('无效')||msg.includes('invalid'))return'请求参数无效: '+msg;if(msg.includes('failed'))return'生成失败: '+msg;return msg}

function mapProgressInfo(task,isVideo){const p=task.progress||0;const status=task.status||'';const detail=task.detail||task.statusText||'';if(status==='pending'||status==='queued')return{text:'排队等待中...',pct:5};if(status==='processing'||status==='running'){if(p<20)return{text:'正在分析提示词...',pct:15};if(p<40)return{text:isVideo?'正在生成视频初稿...':'正在生成图片初稿...',pct:30};if(p<60)return{text:isVideo?'正在细化视频细节...':'正在细化图片细节...',pct:50};if(p<80)return{text:isVideo?'正在渲染最终视频...':'正在渲染最终图片...',pct:70};if(p<95)return{text:'即将完成...',pct:88};return{text:'最后处理中...',pct:95}}if(detail)return{text:detail,pct:Math.max(10,Math.min(90,p))};return{text:'生成中... '+p+'%',pct:Math.max(10,Math.min(90,p))}}
function formatElapsed(ms){const s=Math.floor(ms/1000);if(s<60)return s+'秒';const m=Math.floor(s/60);return m+'分'+(s%60)+'秒'}

async function pollTask(tid,st,entry){
  // v0.1: keydraw.97api.com 长轮询
  // POST /api/image-tasks/{id}/resume-poll {extra_timeout_secs:120}
  // 响应格式: {id, mode, status:"queued"|"running"|"success"|"failed", progress:"...", data:[{url, revised_prompt}], duration_ms}
  const max=300*1000,start=Date.now();let errs=0;
  function resolveUrl(v){if(!v)return v;if(v.startsWith('data:')||v.startsWith('http://')||v.startsWith('https://'))return v;if(v.startsWith('/'))return 'https://keydraw.97api.com'+v;return v}
  while(Date.now()-start<max){
    try{
      const r=await apiFetch('/image-tasks/'+encodeURIComponent(tid)+'/resume-poll',{method:'POST',body:JSON.stringify({extra_timeout_secs:120}),_sessionToken:st});
      const d=await r.json();
      if(!r.ok){
        const pollErr=d.error||d.message||'轮询失败';
        if(isAuthError(pollErr)&&!authRetried){
          // gift-key 模式下不太可能过期，但保留逻辑
        }
        throw new Error(pollErr);
      }
      // v0.1: keydraw 直接在顶层返回任务字段（无 d.task / d.video 包装）
      const status=d.status||'';
      const progress=d.progress||'';
      // 更新进度
      var pct=50,ptext='生成中';
      if(status==='queued'){pct=5;ptext='排队中'}
      else if(status==='running'){pct=70;ptext=progress||'生成中'}
      else if(status==='success'){pct=100;ptext='完成'}
      else if(status==='failed'){pct=0;ptext='失败'}
      entry.progress=pct;entry.progressText=ptext;
      updateHistory(entry.id,{progress:entry.progress,progressText:entry.progressText});
      if(d.error){entry.upstreamError=d.error}
      if(status==='success'){
        // 提取图片
        let images=[];
        if(Array.isArray(d.data)){
          d.data.forEach(item=>{
            if(item.url)images.push({type:'url',value:resolveUrl(item.url)});
            else if(item.b64_json)images.push({type:'b64',value:'data:image/png;base64,'+item.b64_json});
          });
        }
        if(!images.length)throw new Error('任务成功但无图片数据');
        return{images,model:d.model||entry.model,taskId:tid};
      }
      if(status==='failed'){
        throw new Error(d.error||d.detail||'生成失败');
      }
      // queued / running → 继续轮询（resume-poll 会阻塞 120s，所以直接 continue）
      errs=0;
    }catch(e){
      errs++;
      if(errs>=8)throw e;
      if(e.name==='AbortError')throw e;
      await sleep(2000*errs);
    }
  }
  var upstreamDetail=entry.upstreamError||'';
  throw new Error('图片生成超时(300秒)' + (upstreamDetail ? '，' + upstreamDetail : ''));
}

// ===== 渲染 =====
function renderAll(){renderTopbar();updateConcurrencyUI()}
// v25: topbar 按"可生成图片数"显示（基于当前选择的模型/档位）
function renderTopbar(){
  var model=document.getElementById('modelSelect')?document.getElementById('modelSelect').value:'gpt-image-2';
  var tier=selectedQualityTier||'standard';
  var usable=state.accounts.filter(a=>!a.disabled&&a.sessionToken).reduce((s,a)=>s+creditsToImageCount(a.credits,model,tier),0);
  var total=state.accounts.filter(a=>!a.disabled).reduce((s,a)=>s+creditsToImageCount(a.credits,model,tier),0);
  document.getElementById('usableCreditsTop').textContent=usable;
  document.getElementById('totalCreditsTop').textContent=total;
}
function updateConcurrencyUI(){const model=getCurrentModel(),tier=getCurrentTier();const mx=maxConcurrency(),cur=activeSlots;var el1=document.getElementById('concurrencyInfo');if(el1)el1.textContent='并发: '+cur+'/'+mx;var el2=document.getElementById('concurrencyDetail');if(el2)el2.textContent='可用账号'+state.accounts.filter(a=>!a.disabled&&a.sessionToken&&canGenerateAtLeastOne(a.credits,model,tier)).length+'个 x '+CONCURRENT_PER_ACCOUNT+' = '+mx+'并发槽位'}

// ===== 构建图片HTML =====
function buildImageHtml(h,imgs){
  var html='';
  var isVideo=h.isVideo||false;
  var hasB64=imgs.some(function(img){return img.type==='b64'});
  if(hasB64){html+='<div style="padding:4px 12px;font-size:.72rem;color:var(--orange);background:rgba(253,203,110,.08)">\\u26A0 部分数据为临时内容，刷新后将丢失，请及时保存</div>'}
  // 获取当前session token用于媒体代理认证
  var currentToken='';
  var acc=state.accounts.find(function(a){return a.sessionToken});
  if(acc)currentToken=acc.sessionToken;
  html+='<div class="hist-img-link">';
  imgs.forEach(function(img,imgIdx){
    var rawSrc;
    if(img.type==='b64'||img.value.startsWith('data:')){rawSrc=img.value}
    else if(img.value.startsWith('http')){rawSrc=img.value}
    else{rawSrc='https://grok.17nas.com'+(img.value.startsWith('/')?'':'/')+img.value}
    var isVideoFile=img.type==='video'||rawSrc.match(/\\.(mp4|webm)(\\?|$)/i);
    if(isVideoFile){
      var videoSrc=proxyImageUrl(rawSrc);
      if(currentToken&&!videoSrc.startsWith('data:')){videoSrc+=(videoSrc.includes('?')?'&':'?')+'token='+encodeURIComponent(currentToken)}
      var dlHref=rawSrc;
      if(!dlHref.startsWith('data:')&&currentToken){dlHref=videoSrc}
      html+='<a href="'+dlHref+'" target="_blank" download="video_'+h.id+'_'+imgIdx+'.mp4">\\u2197 查看和保存视频</a>';
      html+='<video src="'+videoSrc+'" controls style="max-width:100%;max-height:300px;margin:4px 12px 8px;border-radius:6px;display:block"></video>';
    }else{
      var dlHref=rawSrc;
      // 下载链接也走代理，确保浏览器能下载
      if(!dlHref.startsWith('data:')&&currentToken){
        var proxySrc=proxyImageUrl(rawSrc);
        if(proxySrc!==rawSrc){dlHref=proxySrc+(proxySrc.includes('?')?'&':'?')+'token='+encodeURIComponent(currentToken)}
      }
      html+='<a href="'+dlHref+'" target="_blank" download="image_'+h.id+'_'+imgIdx+'.png">\\u2197 查看和保存原图</a>';
    }
  });
  html+='</div>';
  return html;
}

// ===== 历史渲染 =====
function ensureEmptyEl(){let el=document.getElementById('historyEmpty');if(!el){const c=document.getElementById('historyList');el=document.createElement('p');el.id='historyEmpty';el.style.cssText='color:var(--fg3);text-align:center;padding:40px 0;font-size:.85rem';el.textContent='暂无历史记录';c.prepend(el)}return el}
function renderFullHistory(){const c=document.getElementById('historyList');c.querySelectorAll('.hist-item').forEach(el=>el.remove());const empty=ensureEmptyEl();if(!generationHistory.length){empty.style.display='';return}empty.style.display='none';for(let i=generationHistory.length-1;i>=0;i--){const el=buildHistoryElement(generationHistory[i]);if(empty.nextSibling){c.insertBefore(el,empty.nextSibling)}else{c.appendChild(el)}}}
function renderHistoryItem(h){const c=document.getElementById('historyList');const empty=ensureEmptyEl();empty.style.display='none';const el=buildHistoryElement(h);if(empty.nextSibling){c.insertBefore(el,empty.nextSibling)}else{c.appendChild(el)}}

function patchHistoryItem(h){
  const el=document.querySelector('[data-hist-id="'+h.id+'"]');if(!el){renderHistoryItem(h);return}
  const statusEl=el.querySelector('.hist-status');
  if(statusEl){const statusMap={success:{cls:'ok',label:'\\u2713成功'},error:{cls:'err',label:'\\u2717失败'},timeout:{cls:'timeout',label:'\\u23F1超时'},running:{cls:'running',label:'\\u25CF生成中'},queued:{cls:'queued',label:'\\u25CB排队中'}};const st=statusMap[h.status]||statusMap.error;statusEl.className='hist-status '+st.cls;statusEl.textContent=st.label}
  if(h.status==='running'||h.status==='queued'){el.classList.add('running-item')}else{el.classList.remove('running-item')}
  const progressContainer=el.querySelector('.hist-progress');
  if(h.status==='running'||h.status==='queued'){const startTs=taskStartTimes.get(h.id)||h.timestamp;const elapsed=Date.now()-startTs;const elapsedStr=formatElapsed(elapsed);if(progressContainer){progressContainer.querySelector('.pfill').style.width=Math.max(5,h.progress||0)+'%';progressContainer.querySelector('.ptxt').innerHTML=escHtml(h.progressText||'等待中')+'<span class="elapsed">'+elapsedStr+'</span>'}else{const promptEl=el.querySelector('.hist-prompt');const div=document.createElement('div');div.className='hist-progress';div.innerHTML='<div class="pbar"><div class="pfill" style="width:'+Math.max(5,h.progress||0)+'%"></div></div><div class="ptxt">'+escHtml(h.progressText||'等待中')+'<span class="elapsed">'+elapsedStr+'</span></div>';promptEl.after(div)}}else if(progressContainer){progressContainer.remove()}
  let errorEl=el.querySelector('.hist-error');if(h.error){if(errorEl){errorEl.textContent=h.error}else{const div=document.createElement('div');div.className='hist-error';div.textContent=h.error;const promptEl=el.querySelector('.hist-prompt');promptEl.after(div)}}
  if(h.status==='success'){const imgs=liveImages.get(h.id);if(imgs&&imgs.length&&!el.querySelector('.hist-img-link')){const imagesHtml=buildImageHtml(h,imgs);const errorEl2=el.querySelector('.hist-error');const promptEl=el.querySelector('.hist-prompt');if(errorEl2){errorEl2.insertAdjacentHTML('afterend',imagesHtml)}else if(promptEl){promptEl.insertAdjacentHTML('afterend',imagesHtml)}}}
}

function buildHistoryElement(h){
  const t=new Date(h.timestamp);
  const timeStr=String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0')+' '+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+':'+String(t.getSeconds()).padStart(2,'0');
  const statusMap={success:{cls:'ok',label:'\\u2713成功'},error:{cls:'err',label:'\\u2717失败'},timeout:{cls:'timeout',label:'\\u23F1超时'},running:{cls:'running',label:'\\u25CF生成中'},queued:{cls:'queued',label:'\\u25CB排队中'}};
  const st=statusMap[h.status]||statusMap.error;
  const div=document.createElement('div');
  div.className='hist-item'+((h.status==='running'||h.status==='queued')?' running-item':'');
  div.setAttribute('data-hist-id',h.id);
  const statusIconMap={success:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#00CC00"/><path d="M4.5 8L7 10.5L11.5 5.5" stroke="#FFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',error:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#FF0000"/><path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="#FFF" stroke-width="1.8" stroke-linecap="round"/></svg>',timeout:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#FFCC00"/><path d="M8 4.5V8.5L10.5 10" stroke="#FFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',running:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#74b9ff"/><circle cx="8" cy="8" r="2" fill="#FFF"/></svg>',queued:'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill="#A0AEC0"/><circle cx="8" cy="8" r="2" fill="#FFF"/></svg>'};
  const icon=statusIconMap[h.status]||statusIconMap.error;
  let inner='<span class="status-icon">'+icon+'</span><div class="hist-body">';
  inner+='<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="hist-time">'+timeStr+'</span><span class="hist-model">'+escHtml(h.model||'')+'</span>';
  if(h.account)inner+='<span class="hist-account">@'+escHtml(h.account)+'</span>';
  inner+='<span style="flex:1"></span>';
  inner+='<span class="hist-actions">';
  inner+='<button class="icon-btn" onclick="copyHistPrompt(this)" title="复制提示词"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>';
  if(h.status==='success'){
    inner+='<button class="icon-btn" onclick="downloadHistImage(this)" title="下载图片"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
  }
  inner+='</span></div>';
  inner+='<div class="hist-prompt">'+escHtml(h.prompt)+'</div>';
  if(h.error)inner+='<div class="hist-error">'+escHtml(h.error)+'</div>';
  if(h.status==='running'||h.status==='queued'){const startTs=taskStartTimes.get(h.id)||h.timestamp;const elapsed=formatElapsed(Date.now()-startTs);inner+='<div class="hist-progress"><div class="pbar"><div class="pfill" style="width:'+Math.max(5,h.progress||0)+'%"></div></div><div class="ptxt">'+escHtml(h.progressText||'等待中')+'<span class="elapsed">'+elapsed+'</span></div></div>'}
  const imgs=liveImages.get(h.id);
  if(imgs&&imgs.length){inner+=buildImageHtml(h,imgs)}
  inner+='</div>'; // close hist-body
  div.innerHTML=inner;
  return div;
}

function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function proxyImageUrl(src){if(!src)return src;if(src.startsWith('data:'))return src;if(src.startsWith('http://'))return '/api/media-proxy?url='+encodeURIComponent(src);if(src.startsWith('https://grok.17nas.com/'))return '/api/media-proxy?url='+encodeURIComponent(src);if(src.startsWith('https://'))return src;if(src.startsWith('/local-api/'))return '/api/media-proxy?url='+encodeURIComponent('https://grok.17nas.com'+src);return src}

function downloadHistImage(el){
  var histEl=el.closest('[data-hist-id]');
  if(!histEl)return;
  var id=histEl.getAttribute('data-hist-id');
  var imgs=liveImages.get(id);
  if(!imgs||!imgs.length){toast('暂无可下载图片','info');return}
  var link=histEl.querySelector('.hist-img-link a[download]');
  if(link){link.click();return}
  var img=imgs[0];
  if(img.type==='b64'||img.value.startsWith('data:')){
    var a=document.createElement('a');a.href=img.value;a.download='image_'+id+'.png';a.click();
  }else{
    var proxySrc=proxyImageUrl(img.value);
    var acc=state.accounts.find(function(a){return a.sessionToken});
    if(acc&&!proxySrc.startsWith('data:'))proxySrc+=(proxySrc.includes('?')?'&':'?')+'token='+encodeURIComponent(acc.sessionToken);
    var a=document.createElement('a');a.href=proxySrc;a.target='_blank';a.download='image_'+id+'.png';a.click();
  }
}

setInterval(()=>{document.querySelectorAll('.hist-item.running-item').forEach(el=>{const id=el.getAttribute('data-hist-id');const startTs=taskStartTimes.get(id);if(!startTs)return;const elapsedEl=el.querySelector('.elapsed');if(elapsedEl)elapsedEl.textContent=formatElapsed(Date.now()-startTs)})},1000);

// ===== 参考图 =====
function handleRefImages(input){const files=Array.from(input.files).filter(f=>f.type.startsWith('image/'));if(!files.length)return;let pending=files.length;files.forEach(f=>{const r=new FileReader();r.onload=e=>{refImages.push({name:f.name,type:f.type,dataUrl:e.target.result});pending--;if(pending===0)renderRefGrid()};r.readAsDataURL(f)});input.value=''}
function addMoreRefImages(){document.getElementById('refFileInput').click()}
function renderRefGrid(){const g=document.getElementById('refGrid');if(!refImages.length){g.innerHTML='<div class="ref-add" onclick="addMoreRefImages()" id="refAddBtn" title="添加参考图"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>';setupRefDragDrop();return}g.innerHTML=refImages.map((img,i)=>'<div class="ref-thumb"><img src="'+img.dataUrl+'" alt="ref'+(i+1)+'"><span class="ref-del" onclick="removeRefImage('+i+')">&times;</span></div>').join('')+'<div class="ref-add" onclick="addMoreRefImages()" id="refAddBtn" title="添加参考图"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>';setupRefDragDrop()}
function removeRefImage(i){refImages.splice(i,1);renderRefGrid()}
function setupRefDragDrop(){
  var el=document.getElementById('refAddBtn');
  if(!el)return;
  el.addEventListener('dragover',function(e){e.preventDefault();el.classList.add('dragover')});
  el.addEventListener('dragleave',function(){el.classList.remove('dragover')});
  el.addEventListener('drop',function(e){e.preventDefault();el.classList.remove('dragover');var files=Array.from(e.dataTransfer.files).filter(f=>f.type.startsWith('image/'));if(!files.length)return;var pending=files.length;files.forEach(f=>{var r=new FileReader();r.onload=ev=>{refImages.push({name:f.name,type:f.type,dataUrl:ev.target.result});pending--;if(pending===0)renderRefGrid()};r.readAsDataURL(f)})});
}
// Ratio select init
(function(){var sel=document.getElementById('ratioSelect');if(sel){sel.value=selectedRatio}})();

// Mobile drawer
function relocate(){var tc=document.getElementById('taskCard'),cp=document.getElementById('centerPanel'),db=document.getElementById('drawerBody');if(!tc||!cp||!db)return;if(innerWidth<=768){if(tc.parentElement!==db)db.appendChild(tc)}else{if(tc.parentElement!==cp)cp.appendChild(tc);document.getElementById('historyDrawer').classList.remove('open')}}
function toggleDrawer(){var d=document.getElementById('historyDrawer'),svg=d.querySelector('.drawer-header button svg');d.classList.toggle('open');if(svg)svg.setAttribute('points',d.classList.contains('open')?'6 9 12 15 18 9':'18 15 12 9 6 15')}
relocate();addEventListener('resize',relocate);

// ===== 设置弹窗 =====
function showSettingsModal(){renderAccountsTable();loadSettingsUI();renderStorageInfo();document.getElementById('settingsModal').classList.add('show')}
function closeSettingsModal(){document.getElementById('settingsModal').classList.remove('show')}
// v25: 账号表显示"可生成图片数"替代原始 credits；移除签到列；增加废弃按钮
function renderAccountsTable(){
  const today=new Date().toISOString().split('T')[0],c=document.getElementById('accountsTableContainer');
  var model=getCurrentModel(),tier=getCurrentTier();
  var costPerImg=getCreditsPerImage(model,tier);
  if(!state.accounts.length){
    c.innerHTML='<p style="color:var(--text-muted);text-align:center;padding:20px">暂无账号</p>';
  }else{
    c.innerHTML='<table class="accounts-table"><thead><tr><th>用户名</th><th>密码</th><th>余额</th><th>可生成(张)</th><th>操作</th></tr></thead><tbody>'
      +state.accounts.map((a,i)=>{
        var imgCount=creditsToImageCount(a.credits,model,tier);
        var canGen=canGenerateAtLeastOne(a.credits,model,tier);
        var creditsColor=canGen?'var(--text)':'var(--red)';
        var imgColor=canGen?'var(--green)':'var(--red)';
        return '<tr>'
          +'<td style="font-family:var(--mono);font-size:.8rem;'+(a.disabled?'opacity:.5;text-decoration:line-through':'')+'">'+escHtml(a.username)+'</td>'
          +'<td style="font-family:var(--mono);font-size:.75rem;cursor:pointer" onclick="navigator.clipboard.writeText(this.textContent).then(function(){toast(\\'已复制密码\\',\\'success\\')}).catch(function(){})" title="点击复制密码">'+escHtml(a.password||'')+'</td>'
          +'<td style="color:'+creditsColor+'">'+(a.credits||0)+'</td>'
          +'<td style="color:'+imgColor+';font-weight:600">'+imgCount+'</td>'
          +'<td><button class="btn btn-sm" onclick="loginAndRefresh('+i+')">登录</button> '
          +'<button class="btn btn-sm btn-danger" onclick="removeAccount('+i+')">删除</button> '
          +(!canGen?'<button class="btn btn-xs btn-outline" onclick="autoAbandonAccount('+i+',\\'手动废弃\\');saveState();renderAll();renderAccountsTable();toast(\\'已移入废弃池\\',\\'success\\')">废弃</button>':'')
          +'</td></tr>';
      }).join('')+'</tbody></table>';
  }
  renderAbandonedPool();
}
async function loginAndRefresh(i){try{await loginAccount(i);await refreshQuota(i);renderAccountsTable()}catch(e){}}
function removeAccount(i){if(!confirm('确定删除'+state.accounts[i].username+'？'))return;state.accounts.splice(i,1);if(state.activeAccountIndex>=state.accounts.length)state.activeAccountIndex=state.accounts.length-1;saveState();renderAll();renderAccountsTable();toast('已删除','success')}
// v25: 废弃池表格增加"原因"和"余额"列
function renderAbandonedPool(){
  var c=document.getElementById('abandonedPoolContainer');if(!c)return;
  var ab=state.abandonedAccounts||[];
  if(!ab.length){c.innerHTML='';return}
  var rows=ab.map(function(a,i){
    var d=new Date(a.abandonedAt||Date.now());
    var ts=String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    var reason=a.reason||'未知';
    var credits=a.credits!==undefined?a.credits:'?';
    return '<tr>'
      +'<td style="font-family:var(--mono);font-size:.8rem;color:var(--text-muted)">'+escHtml(a.username)+'</td>'
      +'<td style="font-family:var(--mono);font-size:.75rem;cursor:pointer;color:var(--text-muted)" onclick="navigator.clipboard.writeText(this.textContent).then(function(){toast(\\'已复制密码\\',\\'success\\')}).catch(function(){})" title="点击复制密码">'+escHtml(a.password||'')+'</td>'
      +'<td style="font-size:.78rem;color:var(--text-muted)">'+credits+'</td>'
      +'<td style="font-size:.72rem;color:var(--orange);max-width:160px;overflow:hidden;text-overflow:ellipsis" title="'+escHtml(reason)+'">'+escHtml(reason)+'</td>'
      +'<td style="font-size:.78rem;color:var(--text-muted)">'+ts+'</td>'
      +'<td><button class="btn btn-xs" onclick="reverifyAbandoned('+i+')" title="重新登录验证，如余额已恢复可还原">重新验证</button> <button class="btn btn-xs" onclick="restoreAbandoned('+i+')">还原</button> <button class="btn btn-xs btn-danger" onclick="deleteAbandoned('+i+')">删除</button></td>'
      +'</tr>';
  }).join('');
  c.innerHTML='<div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
    +'<span style="font-size:.85rem;color:var(--orange);font-weight:600">\\u26A0 废弃账号池 ('+ab.length+')</span>'
    +'<div style="display:flex;gap:6px">'
    +'<button class="btn btn-xs" onclick="reverifyAllAbandoned()">一键验证全部</button>'
    +'<button class="btn btn-xs btn-danger" onclick="clearAbandoned()">一键清空</button>'
    +'</div></div>'
    +'<table class="accounts-table"><thead><tr><th>用户名</th><th>密码</th><th>余额</th><th>原因</th><th>废弃时间</th><th>操作</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'</div>';
}
async function reverifyAbandoned(i){var ab=state.abandonedAccounts||[];if(!ab[i])return;var a=ab[i];toast('正在验证 '+a.username+'...','info');try{var r=await apiFetch('/auth/login',{method:'POST',body:JSON.stringify({username:a.username,password:a.password})});var d=await r.json();if(r.ok){var st=r.headers.get('X-Session-Token')||'';state.accounts.push({username:a.username,password:a.password,sessionToken:st,credits:d.user?.imageCredits||0,lastCheckinDay:d.user?.lastCheckInDay||'',lastCheckinTs:0,createdAt:Date.now(),disabled:false,userId:d.user?.id||'',loginFailCount:0,lastLoginFailTs:0});ab.splice(i,1);state.abandonedAccounts=ab;saveState();renderAll();renderAccountsTable();toast(a.username+' 验证成功，已还原到活跃池','success')}else{toast(a.username+' 验证失败: '+(d.error||'登录失败'),'error');await sleep(2500)}}catch(e){toast(a.username+' 验证失败: '+e.message,'error');await sleep(2500)}}
async function reverifyAllAbandoned(){var ab=state.abandonedAccounts||[];if(!ab.length){toast('废弃池为空','info');return}toast('开始验证 '+ab.length+' 个废弃账号...','info');var okN=0,failN=0;for(var i=ab.length-1;i>=0;i--){try{var a=ab[i];var r=await apiFetch('/auth/login',{method:'POST',body:JSON.stringify({username:a.username,password:a.password})});var d=await r.json();if(r.ok){var st=r.headers.get('X-Session-Token')||'';state.accounts.push({username:a.username,password:a.password,sessionToken:st,credits:d.user?.imageCredits||0,lastCheckinDay:d.user?.lastCheckInDay||'',lastCheckinTs:0,createdAt:Date.now(),disabled:false,userId:d.user?.id||'',loginFailCount:0,lastLoginFailTs:0});ab.splice(i,1);okN++}else{failN++}await sleep(2500)}catch(e){failN++;await sleep(2500)}}state.abandonedAccounts=ab;saveState();renderAll();renderAccountsTable();toast('验证完成: '+okN+'个还原成功'+(failN?'，'+failN+'个仍失败':''),okN>0?'success':'error')}
function clearAbandoned(){if(!confirm('确定清空所有废弃账号？此操作不可恢复！'))return;state.abandonedAccounts=[];saveState();renderAccountsTable();toast('废弃池已清空','success')}
function deleteAbandoned(i){var ab=state.abandonedAccounts||[];if(!ab[i])return;if(!confirm('确定删除废弃账号 '+ab[i].username+'？'))return;ab.splice(i,1);state.abandonedAccounts=ab;saveState();renderAccountsTable();toast('已删除','success')}
function restoreAbandoned(i){var ab=state.abandonedAccounts||[];if(!ab[i])return;var a=ab[i];state.accounts.push({username:a.username,password:a.password,sessionToken:'',credits:0,lastCheckinDay:'',lastCheckinTs:0,createdAt:Date.now(),disabled:false,userId:'',loginFailCount:0,lastLoginFailTs:0});ab.splice(i,1);state.abandonedAccounts=ab;if(state.activeAccountIndex<0)state.activeAccountIndex=0;saveState();renderAll();renderAccountsTable();toast(a.username+' 已还原到活跃池（需手动登录验证）','success')}
function saveSettings(){state.settings.defaultPassword=document.getElementById('defaultPassword').value.trim()||'Ml@2026Proxy';state.settings.rotationStrategy=document.getElementById('rotationStrategy').value;state.settings.autoCheckin=document.getElementById('autoCheckin').checked;state.settings.autoRegister=document.getElementById('autoRegisterChk').checked;state.settings.autoFallbackGpt2=document.getElementById('autoFallbackGpt2').checked;state.settings.notificationsEnabled=document.getElementById('notificationsEnabled').checked;saveState();updateNotificationsHint();toast('设置已保存','success')}
function loadSettingsUI(){document.getElementById('defaultPassword').value=state.settings.defaultPassword||'Ml@2026Proxy';document.getElementById('rotationStrategy').value=state.settings.rotationStrategy||'most-credits';document.getElementById('autoCheckin').checked=state.settings.autoCheckin!==false;document.getElementById('autoRegisterChk').checked=state.settings.autoRegister!==false;document.getElementById('autoFallbackGpt2').checked=state.settings.autoFallbackGpt2!==false;document.getElementById('notificationsEnabled').checked=state.settings.notificationsEnabled===true;applyTheme();updateNotificationsHint()}
// v24: 通知开关交互
async function onNotificationsToggle(checked){
  if(checked){
    var granted=await requestNotificationPermission();
    if(!granted){
      document.getElementById('notificationsEnabled').checked=false;
      state.settings.notificationsEnabled=false;
      saveState();
    }else{
      state.settings.notificationsEnabled=true;
      saveState();
      // 发一个测试通知
      try{
        new Notification('通知已开启',{body:'图片生成完成后会在此提醒您',icon:'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="%236A5ACD"/><text x="32" y="42" font-size="36" text-anchor="middle" fill="white" font-family="sans-serif">AI</text></svg>'});
      }catch(e){}
    }
    updateNotificationsHint();
  }else{
    state.settings.notificationsEnabled=false;
    saveState();
    updateNotificationsHint();
  }
}
function updateNotificationsHint(){
  var el=document.getElementById('notificationsHint');
  if(!el)return;
  if(!notificationsSupported()){
    el.textContent='当前浏览器不支持通知 API';
    el.style.color='var(--text-muted)';
    return;
  }
  var perm=Notification.permission;
  var enabled=state.settings.notificationsEnabled===true;
  if(enabled&&perm==='granted'){
    el.textContent='已开启，将在生成完成时提醒';
    el.style.color='var(--green)';
  }else if(enabled&&perm!=='granted'){
    el.textContent='已开启但权限未授予，请点击开关重新授权';
    el.style.color='var(--orange)';
  }else if(perm==='denied'){
    el.textContent='浏览器通知权限已被拒绝，请在浏览器设置中手动开启';
    el.style.color='var(--red)';
  }else{
    el.textContent='开启后将请求浏览器通知权限';
    el.style.color='var(--text-muted)';
  }
}
// v26.1: 导出账号 - 支持三种模式 (all/active/abandoned)，导出前自动检测废弃
// mode: 'all' = 可用+废弃 | 'active' = 仅可用 | 'abandoned' = 仅废弃池
// 导出 'all' 和 'active' 前会先调用 cleanupInsufficientAccounts 检测余额不足的账号并移入废弃池
async function exportAccounts(mode){
  mode = mode || 'all';
  // v26.1: 导出前检测废弃（仅对 all/active 模式，abandoned 模式直接导出废弃池无需检测）
  if(mode === 'all' || mode === 'active'){
    if(state.accounts.length > 0){
      toast('导出前正在检测账号余额...','info');
      try{
        await cleanupInsufficientAccounts();
      }catch(e){
        console.warn('导出前检测失败:', e);
      }
    }
  }

  var activeAccounts = state.accounts.map(a=>({
    username:a.username,
    password:a.password,
    credits:a.credits||0,
    createdAt:a.createdAt||0
  }));
  var abandonedAccounts = (state.abandonedAccounts||[]).map(a=>({
    username:a.username,
    password:a.password,
    credits:a.credits!==undefined?a.credits:0,
    reason:a.reason||'',
    abandonedAt:a.abandonedAt||0
  }));

  var data, filenameSuffix, toastMsg;
  if(mode === 'active'){
    data = {accounts: activeAccounts, abandonedAccounts: []};
    filenameSuffix = 'active';
    toastMsg = '已导出 '+activeAccounts.length+' 个可用账号';
  }else if(mode === 'abandoned'){
    data = {accounts: [], abandonedAccounts: abandonedAccounts};
    filenameSuffix = 'abandoned';
    toastMsg = '已导出 '+abandonedAccounts.length+' 个废弃账号';
  }else{
    // all
    data = {accounts: activeAccounts, abandonedAccounts: abandonedAccounts};
    filenameSuffix = 'all';
    toastMsg = '已导出 '+activeAccounts.length+' 个可用 + '+abandonedAccounts.length+' 个废弃';
  }

  var b = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  var u = URL.createObjectURL(b);
  var a = document.createElement('a');
  a.href = u;
  a.download = 'ai_image_accounts_'+filenameSuffix+'_'+new Date().toISOString().split('T')[0]+'.json';
  a.click();
  URL.revokeObjectURL(u);
  toast(toastMsg, 'success');
}
function importAccounts(){document.getElementById('importFileInput').click()}
async function handleImportFile(input){const file=input.files[0];if(!file)return;try{const txt=await file.text();const data=JSON.parse(txt);var arr=Array.isArray(data)?data:(data.accounts||[data]);let n=0;arr.forEach(item=>{if(item.username&&item.password&&!state.accounts.some(a=>a.username===item.username)){state.accounts.push({username:item.username,password:item.password,sessionToken:'',credits:0,lastCheckinDay:'',lastCheckinTs:0,createdAt:Date.now(),disabled:false,userId:'',loginFailCount:0,lastLoginFailTs:0});n++}});var abArr=data.abandonedAccounts||[];let abN=0;abArr.forEach(item=>{if(item.username&&item.password&&!(state.abandonedAccounts||[]).some(a=>a.username===item.username)&&!state.accounts.some(a=>a.username===item.username)){if(!state.abandonedAccounts)state.abandonedAccounts=[];state.abandonedAccounts.push({username:item.username,password:item.password,abandonedAt:item.abandonedAt||Date.now()});abN++}});if(n>0||abN>0){if(state.activeAccountIndex<0)state.activeAccountIndex=0;saveState();renderAll();var msg='';if(n>0)msg+='导入'+n+'个账号';if(abN>0)msg+=(msg?'，':'')+'导入'+abN+'个废弃账号';toast(msg+'，正在登录...','success');for(let i=0;i<state.accounts.length;i++){if(!state.accounts[i].sessionToken&&!state.accounts[i].disabled){try{await loginAccount(i);await sleep(300)}catch(e){}}}}else{toast('无新账号可导入','info')}}catch(e){toast('导入失败: '+e.message,'error')}input.value=''}
function clearAllData(){if(!confirm('确定清除所有数据？'))return;state=defaultState();saveState();generationHistory=[];liveImages.clear();saveHistory();promptLibrary=[];savePromptLib();renderFullHistory();renderAll();loadSettingsUI();toast('已清除','success')}

// ===== 历史记录导入导出 =====
function exportHistory(){if(!generationHistory.length){toast('暂无历史记录可导出','info');return}var exportData=generationHistory.map(function(h){var entry={id:h.id,prompt:h.prompt,model:h.model,ratio:h.ratio,timestamp:h.timestamp,status:h.status,error:h.error||'',account:h.account||'',startedAt:h.startedAt||0};if(h.images&&h.images.length){var imgs=liveImages.get(h.id);entry.images=h.images.map(function(img,idx){if(img.type==='url')return{type:'url',value:img.value};if(imgs&&imgs[idx]&&(imgs[idx].type==='b64'||imgs[idx].value.startsWith('data:'))){return{type:'b64',value:imgs[idx].value}}return{type:img.type,value:img.value}})}return entry});var b=new Blob([JSON.stringify(exportData,null,2)],{type:'application/json'});var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download='ai_image_generator_history_'+new Date().toISOString().split('T')[0]+'.json';a.click();URL.revokeObjectURL(u);toast('历史记录已导出','success')}
function importHistory(){document.getElementById('importHistoryInput').click()}
function handleImportHistory(input){var file=input.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(e){try{var data=JSON.parse(e.target.result);var arr=Array.isArray(data)?data:[data];var n=0;arr.forEach(function(item){if(!item.id||!item.prompt)return;if(generationHistory.some(function(h){return h.id===item.id}))return;generationHistory.push(item);if(item.images&&item.images.length){var restored=item.images.filter(function(img){return img.type==='url'&&img.value}).map(function(img){return{type:img.type,value:img.value}});if(restored.length)liveImages.set(item.id,restored);var b64restored=item.images.filter(function(img){return img.type==='b64'&&img.value&&img.value.startsWith('data:')}).map(function(img){return{type:img.type,value:img.value}});if(b64restored.length){if(!liveImages.has(item.id))liveImages.set(item.id,[]);var existing=liveImages.get(item.id);b64restored.forEach(function(br){if(!existing.some(function(e){return e.value===br.value}))existing.push(br)})}}if(item.startedAt&&item.startedAt>0)taskStartTimes.set(item.id,item.startedAt);else if(item.timestamp)taskStartTimes.set(item.id,item.timestamp);n++});if(n>0){saveHistory();renderFullHistory();toast('导入'+n+'条历史记录','success')}else{toast('无新历史记录可导入','info')}}catch(err){toast('导入失败: '+err.message,'error')}};reader.readAsText(file);input.value=''}

// ===== 工具 =====
function toast(msg,type){type=type||'info';const c=document.getElementById('toastContainer'),el=document.createElement('div');el.className='toast '+type;el.textContent=msg;c.appendChild(el);setTimeout(()=>{el.remove()},4000)}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
document.getElementById('settingsModal').addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))closeSettingsModal()});
function toggleHelpPanel(){document.getElementById('helpPanel').classList.toggle('show')}
document.getElementById('helpPanel').addEventListener('click',function(e){if(e.target===this)toggleHelpPanel()});

// ===== 关闭窗口提示 =====
window.addEventListener('beforeunload',e=>{
  var msgs=[];
  var hasImgs=generationHistory.some(function(h){return h.status==='success'});
  if(hasImgs)msgs.push('1. 请保存已生成的图片（刷新后base64图片将丢失）');
  if(state.accounts.length>0||hasImgs)msgs.push('2. 如有需要，请导出工具设置、生成历史记录、提示词库');
  if(msgs.length||activeSlots>0){
    e.preventDefault();
    var text='离开前请注意：\\n'+msgs.join('\\n');
    if(activeSlots>0)text+='\\n3. 当前有'+activeSlots+'个任务正在运行';
    e.returnValue=text;
    return e.returnValue;
  }
});

// ===== 新一天自动签到+注册 =====
// v24: 上游已下线签到功能，新一天仅触发自动注册（如有需要），并刷新已有账号额度
function checkNewDay(){const today=new Date().toISOString().split('T')[0];if(state.lastAutoDay&&state.lastAutoDay!==today){toast('新的一天！正在初始化...','info');(async()=>{for(let i=0;i<state.accounts.length;i++){if(!state.accounts[i].disabled&&state.accounts[i].sessionToken){try{await refreshQuota(i);await sleep(400)}catch(e){}}}try{await registerAccount()}catch(e){}state.lastAutoDay=today;saveState();toast('新一天初始化完成','success')})()}if(!state.lastAutoDay){state.lastAutoDay=today;saveState()}}
setInterval(checkNewDay,60000);

// ===== 初始化 =====
loadSettingsUI();markInterruptedTasks();restoreLiveImages();renderAll();checkNewDay();renderFullHistory();onModelChange();renderRefGrid();
// v26: 首次访问自动注册账号 + 检测余额 + 刷新额度
// 如果没有任何账号（首次访问/清除数据后），自动注册一个新账号并刷新额度，无需用户手动操作
if(state.accounts.length>0){
  toast('正在恢复'+state.accounts.length+'个账号...','info');
  (async()=>{
    let okCount=0,failCount=0;
    for(let i=0;i<state.accounts.length;i++){
      if(!state.accounts[i].disabled){
        try{await loginAccount(i);okCount++;await sleep(300)}catch(e){failCount++}
      }
    }
    if(okCount>0)toast('已恢复'+okCount+'个账号'+(failCount?'，'+failCount+'个失败':''),okCount>0?'success':'error');
    else if(failCount>0)toast(failCount+'个账号恢复失败','error');
    // v26: 恢复完成后，自动刷新所有账号额度（检测余额不足的自动移入废弃池）
    await refreshAllQuota();
    // v26: 如果恢复后没有可用账号（全部余额不足），自动注册新账号
    var model=getCurrentModel(),tier=getCurrentTier();
    var hasUsable=state.accounts.some(a=>!a.disabled&&a.sessionToken&&canGenerateAtLeastOne(a.credits,model,tier));
    if(!hasUsable&&state.settings.autoRegister!==false){
      toast('无可用账号，自动注册新账号中...','info');
      try{await registerAccount();await refreshAllQuota()}catch(e){}
    }
    ensureChannelReady();
  })();
}
else{
  // v26: 首次访问，自动注册新账号
  toast('首次访问，正在自动注册账号...','info');
  (async()=>{
    try{
      var acc=await registerAccount();
      if(acc){
        // 注册成功后刷新额度（registerAccount 内部已 login，这里再 refreshQuota 确认余额）
        var idx=state.accounts.findIndex(a=>a.username===acc.username);
        if(idx>=0){try{await refreshQuota(idx)}catch(e){}}
        toast('账号注册完成，可以开始生成图片了','success');
      }
    }catch(e){
      toast('自动注册失败：'+e.message+'，请点击设置按钮手动注册','error');
    }
    ensureChannelReady();
  })();
}


// v0.3: populate version badge
(function(){var vb=document.getElementById('versionBadge');if(vb)vb.textContent=VERSION;})();
</script>
</body>
</html>`;


// ===================== Worker 后端 =====================
// v1.0: 多通道代理 —— 从 X-Channel 头（或 ?channel=）决定上游
function pickChannel(request, url){
  let ch = request.headers.get(CHANNEL_HEADER) || url.searchParams.get('channel') || DEFAULT_CHANNEL;
  if(!CHANNELS[ch]) ch = DEFAULT_CHANNEL;
  return ch;
}
async function handleProxy(request, url) {
  const channel = pickChannel(request, url);
  const chCfg = CHANNELS[channel];
  // v0.3+v1.0: keydraw/maliang 上游都用 /api/* 前缀（maliang 走 /local-api/* 已经在 upstreamBase 里）
  // 这里直接透传完整 pathname（keydraw 上游同 /api/*；maliang 上游 base 已含 /local-api，但前端调用 /api/auth/* 等
  // 会被映射成 /local-api/api/auth/* —— 实际是 maliang 期望的 /local-api/auth/*，所以需要剥掉 /api/ 前缀）
  let upstreamPath;
  if(channel === 'maliang'){
    // maliang upstreamBase 已是 https://grok.17nas.com/local-api，前端调 /api/auth/register
    // 应映射到 https://grok.17nas.com/local-api/auth/register，故剥掉 /api/
    upstreamPath = url.pathname.replace(/^\/api\/?/, '') || '/';
  } else {
    // keydraw 上游同 /api/* 前缀，直接透传
    upstreamPath = url.pathname;
  }
  const upstreamUrl = chCfg.upstreamBase + (upstreamPath.startsWith('/') ? '' : '/') + upstreamPath;
  if (request.method === 'OPTIONS') { return new Response(null, { status: 204, headers: corsHeaders() }); }
  const headers = new Headers();
  headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  headers.set('Origin', chCfg.upstreamOrigin);
  headers.set('Referer', chCfg.upstreamOrigin + '/');
  headers.set('Accept', 'application/json, text/plain, */*');
  headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
  const userAgents = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15','Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'];
  const ua = request.headers.get('User-Agent') || userAgents[Math.floor(Math.random() * userAgents.length)];
  headers.set('User-Agent', ua);
  const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || '';
  if (clientIP) { headers.set('X-Forwarded-For', clientIP); headers.set('X-Real-IP', clientIP); }
  // v1.0: 按通道类型设置鉴权头
  // keydraw=Bearer（前端通过 Authorization 发来，直接透传）
  // maliang=Cookie（前端通过 X-Session-Token 发来 token，转成 Cookie: session=<token>）
  if(chCfg.authMode === 'bearer'){
    const authHdr = request.headers.get('Authorization') || request.headers.get(SESSION_HEADER);
    if(authHdr) headers.set('Authorization', authHdr.startsWith('Bearer ') ? authHdr : ('Bearer ' + authHdr));
  } else if(chCfg.authMode === 'cookie'){
    const st = request.headers.get(SESSION_HEADER) || request.headers.get('Authorization')?.replace(/^Bearer\s+/, '') || '';
    if(st) headers.set('Cookie', chCfg.sessionCookie + '=' + st);
  }
  const opts = { method: request.method, headers, redirect: 'follow' };
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) { try { const buf = await request.arrayBuffer(); if (buf.byteLength > 0) opts.body = buf; } catch (e) {} }
  try {
    const upResp = await fetch(upstreamUrl, opts);
    let token = ''; try { const rawCookie = upResp.headers.get('set-cookie') || ''; const m = rawCookie.match(new RegExp(chCfg.sessionCookie + '=([^;\\s]+)')); if (m) token = m[1]; } catch (e) {}
    const respHeaders = new Headers(corsHeaders()); const ct = upResp.headers.get('Content-Type'); if (ct) respHeaders.set('Content-Type', ct); if (token) respHeaders.set(SESSION_HEADER, token);
    const body = await upResp.arrayBuffer();
    return new Response(body, { status: upResp.status, statusText: upResp.statusText, headers: respHeaders });
  } catch (err) { return new Response(JSON.stringify({ error: '代理请求失败: ' + err.message }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }); }
}
// v26.1: 移除 generateRandomIP() —— 伪造 IP 已确认无效（CF cross-zone 限制）
function corsHeaders() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token, X-Channel', 'Access-Control-Expose-Headers': 'X-Session-Token', 'Access-Control-Max-Age': '86400' }; }

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/image-proxy') || url.pathname.startsWith('/api/media-proxy')) {
      const channel = pickChannel(request, url);
      const chCfg = CHANNELS[channel];
      const imageUrl = url.searchParams.get('url'); if (!imageUrl) { return new Response('Missing url parameter', { status: 400, headers: corsHeaders() }); }
      try {
        const mediaHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': 'image/*,video/*,*/*;q=0.8', 'Referer': chCfg.upstreamOrigin + '/', 'Origin': chCfg.upstreamOrigin };
        const st = request.headers.get(SESSION_HEADER) || url.searchParams.get('token') || '';
        if (st && chCfg.authMode === 'cookie') mediaHeaders['Cookie'] = chCfg.sessionCookie + '=' + st;
        if (st && chCfg.authMode === 'bearer') mediaHeaders['Authorization'] = 'Bearer ' + st;
        const imgResp = await fetch(imageUrl, { headers: mediaHeaders, cf: { cacheEverything: true, cacheTtl: 86400, cacheTtlByStatus: { '200-299': 86400, '400-499': 60, '500-599': 0 } } });
        const contentType = imgResp.headers.get('Content-Type') || 'application/octet-stream'; const body = await imgResp.arrayBuffer();
        return new Response(body, { status: imgResp.status, headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length' } });
      } catch (err) { return new Response('Image proxy failed: ' + err.message, { status: 502, headers: corsHeaders() }); }
    }
    // v0.1+v1.0: gift-key route — 仅 keydraw 通道支持；从 X-Channel 决定上游
    if (url.pathname === '/api/gift-key') {
      const channel = pickChannel(request, url);
      const chCfg = CHANNELS[channel];
      try {
        const r = await fetch(chCfg.upstreamBase + '/api/gift-key', {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': chCfg.upstreamOrigin + '/' },
          cf: { cacheTtl: 60, cacheEverything: false }
        });
        const ct = r.headers.get('Content-Type') || 'application/json';
        const body = await r.arrayBuffer();
        return new Response(body, { status: r.status, headers: { 'Content-Type': ct, 'Cache-Control': 'no-store', ...corsHeaders() } });
      } catch (err) {
        return new Response(JSON.stringify({ key: chCfg.giftKeyFallback }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }
    if (url.pathname.startsWith('/api/')) { return handleProxy(request, url); }
    return new Response(HTML_CONTENT, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' } });
  },
}