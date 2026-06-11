// ============================================================
// TTS Voice Lab v2.8 — Cloudflare Worker
// NiceVoice (primary) + IndexTTS + KikiVoice (backup)
// Voice cloning TTS with subtitle generation & JianYing export
// ============================================================

const VERSION = '2.11.0';
const DEFAULT_INDEX_API = 'https://kozzzq-indextts2api.hf.space';

// NiceVoice API constants
const NV_API_BASE = 'https://api.turbovoice.online';
const NV_HMAC_KEY = '9BSGc4rO5uSkAEDO1UaHur6fui5B5jJ4';
const NV_APP_ID = '10';
const NV_APP_CODE = '110';
const NV_WAIT_MS = 16000; // 16s between TTS requests
const NV_MAX_POLL = 60;
const NV_MAX_CHARS = 150;

// KikiVoice API constants
const KIKA_BASE = 'https://kikivoice.ai';
const KK_MAX_RETRIES = 3;

function uuidv4() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16);}); }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-appid, x-code, x-os, x-ts, x-account, x-sign, x-token',
  };
}

// ==================== NiceVoice HMAC Signing ====================
// Hex-decode the HMAC key (non-hex chars produce 0 bytes, matching NiceVoice's Ff() function)
function hexDecodeKey(hexStr) {
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) {
    const val = parseInt(hexStr.substring(i, i + 2), 16);
    bytes[i / 2] = isNaN(val) ? 0 : val;
  }
  return bytes;
}

async function nvSign(bodyObj, ts, account) {
  const dataStr = (ts + account + JSON.stringify(bodyObj)).toLowerCase();
  const keyData = hexDecodeKey(NV_HMAC_KEY);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataStr));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function nvHeaders(bodyObj, account) {
  const ts = Date.now().toString();
  const sign = await nvSign(bodyObj, ts, account || '');
  return {
    'Content-Type': 'application/json',
    'x-os': 'web',
    'x-appid': NV_APP_ID,
    'x-code': NV_APP_CODE,
    'x-ts': ts,
    'x-account': account || '',
    'x-sign': sign,
    'x-token': 'token',
  };
}

// ==================== NiceVoice API Proxy ====================
async function nvProxy(path, bodyObj, account) {
  const headers = await nvHeaders(bodyObj, account);
  const resp = await fetch(NV_API_BASE + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = { code: resp.status, raw: text }; }
  return new Response(JSON.stringify(data), {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}


// ==================== KikiVoice Proxy Helpers ====================
async function kikiFetch(path, uuid, options={}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://kikivoice.ai',
    'Referer': 'https://kikivoice.ai/ai-voice-cloning/zh-cn',
    'Cookie': 'uuid=' + uuid,
  };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  const fetchOpts = { method: options.method||'GET', headers };
  if (options.body) fetchOpts.body = options.body;
  console.log('[KIKA] ' + fetchOpts.method + ' ' + path.substring(0,80));
  const resp = await fetch(KIKA_BASE + path, fetchOpts);
  const t = await resp.text();
  console.log('[KIKA] ' + resp.status + ': ' + t.substring(0,300));
  return { status: resp.status, body: t, headers: resp.headers };
}

async function kikiProxyResponse(kikiResult) {
  const h = {'Content-Type':'application/json',...corsHeaders()};
  const sc = kikiResult.headers.get('Set-Cookie');
  if (sc) h['X-Set-Cookie'] = sc;
  return new Response(kikiResult.body, {status:kikiResult.status, headers:h});
}

// ==================== Worker Handler ====================
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Serve main page
    if (path === '/' && request.method === 'GET') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300', ...corsHeaders() },
      });
    }

    // NiceVoice API proxy endpoints
    if (path.startsWith('/api/nv/')) {
      try {
        const nvPath = '/clone' + path.substring(7); // /api/nv/getUploadUrl -> /clone/getUploadUrl
        const bodyText = await request.text();
        const bodyObj = bodyText ? JSON.parse(bodyText) : {};
        // Always use empty account for anonymous mode
        return await nvProxy(nvPath, bodyObj, '');
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    }

    // NiceVoice upload proxy (PUT to presigned URL)
    if (path === '/api/nv-upload' && request.method === 'POST') {
      try {
        const { uploadUrl, audioBase64 } = await request.json();
        const audioBytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
        const resp = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'audio/wav' },
          body: audioBytes,
        });
        return new Response(JSON.stringify({ ok: resp.ok, status: resp.status }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    }

    // Audio download proxy
    if (path === '/api/audio-proxy' && request.method === 'GET') {
      try {
        const audioUrl = url.searchParams.get('url');
        if (!audioUrl) return new Response('Missing url', { status: 400 });
        const resp = await fetch(audioUrl);
        const headers = new Headers();
        headers.set('Content-Type', resp.headers.get('Content-Type') || 'audio/mpeg');
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(resp.body, { status: resp.status, headers });
      } catch (e) {
        return new Response(e.message, { status: 500, headers: corsHeaders() });
      }
    }


    // ==================== KikiVoice API Proxy ====================
    const kikiUuid = url.searchParams.get('uuid') || request.headers.get('X-Kiki-Uuid') || uuidv4();

    if (path === '/api/kiki/model-capabilities') {
      const rr = await kikiFetch('/jsapi/model-capabilities', kikiUuid);
      return kikiProxyResponse(rr);
    }
    if (path === '/api/kiki/get-sig') {
      const rr = await kikiFetch('/jsapi/get-cloning-file-sig', kikiUuid);
      return kikiProxyResponse(rr);
    }
    if (path === '/api/kiki/detect-language') {
      try {
        const body = await request.json();
        const rr = await kikiFetch('/jsapi/detect-language', kikiUuid, { method: 'POST', contentType: 'application/json', body: JSON.stringify(body) });
        return kikiProxyResponse(rr);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }
    if (path === '/api/kiki/create-clone-task') {
      try {
        const body = await request.json();
        const fd = new FormData();
        fd.append('text', body.text);
        fd.append('clone_source_voice_custom_voice_id', body.voice_id);
        fd.append('lang_name_code', body.lang_code);
        fd.append('emotion', body.emotion || 'normal');
        fd.append('intensity', body.intensity || 'normal');
        fd.append('clone_source_voice_gender', String(body.gender || 0));
        fd.append('model_type', body.model_type);
        if (body.region) fd.append('region', body.region);
        fd.append('speed', String(body.speed || 1.0));
        fd.append('volume', String(body.volume || 100));
        fd.append('audio_format', body.format || 'mp3');
        fd.append('audio_high_quality', String(body.hq || 0));
        fd.append('model_version_text', body.mver || 'default');
        const rr = await kikiFetch('/jsapi/create-new-clone-task', kikiUuid, { method: 'POST', body: fd });
        return kikiProxyResponse(rr);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }
    if (path === '/api/kiki/job-status') {
      const jobId = url.searchParams.get('job_id');
      const rr = await kikiFetch('/jsapi/get-job-task-status?job_id=' + encodeURIComponent(jobId), kikiUuid);
      return kikiProxyResponse(rr);
    }
    if (path === '/api/kiki/upload-voice') {
      try {
        const formData = await request.formData();
        const voiceFile = formData.get('voice-file');
        const sig = formData.get('sig');
        const createUrl = formData.get('create_url');
        const voiceName = formData.get('voice_name') || 'MyVoice';
        if (!voiceFile || !sig || !createUrl) {
          return new Response(JSON.stringify({ errcode: -2, errmsg: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
        }
        const uploadUrl = createUrl + '?voice_name=' + encodeURIComponent(voiceName) + '&denoise=0&asr=1&sig=' + encodeURIComponent(sig);
        const upFd = new FormData();
        upFd.append('voice-file', voiceFile);
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Origin': 'https://kikivoice.ai',
          'Referer': 'https://kikivoice.ai/ai-voice-cloning/zh-cn',
          'Cookie': 'uuid=' + kikiUuid,
        };
        const resp = await fetch(uploadUrl, { method: 'POST', headers, body: upFd });
        const respText = await resp.text();
        return new Response(respText, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      } catch (e) {
        return new Response(JSON.stringify({ errcode: -1, errmsg: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }
    if (path === '/api/kiki-audio') {
      try {
        const audioUrl = url.searchParams.get('url');
        if (!audioUrl) return new Response('Missing url', { status: 400 });
        const resp = await fetch(audioUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://kikivoice.ai/' } });
        const h = new Headers(resp.headers);
        h.set('Access-Control-Allow-Origin', '*');
        h.set('Content-Disposition', 'attachment; filename="kiki_audio.mp3"');
        return new Response(resp.body, { status: resp.status, headers: h });
      } catch (e) {
        return new Response(e.message, { status: 500, headers: corsHeaders() });
      }
    }
    // Geetest validation page proxy
    if (path === '/api/kiki/geetest-page') {
      try {
        const vpath = url.searchParams.get('path');
        if (!vpath) return new Response('Missing path', { status: 400 });
        const resp = await fetch(KIKA_BASE + vpath, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': 'https://kikivoice.ai/',
            'Cookie': 'uuid=' + kikiUuid,
          }
        });
        let html = await resp.text();
        const workerBase = url.origin;
        html = html.replace(/fetch\(['"]\/jsapi\/auth\/geetest-validation['"]/g, "fetch('" + workerBase + "/api/kiki/geetest-submit?uuid=" + encodeURIComponent(kikiUuid) + "'");
        if (!html.includes('<base')) {
          html = html.replace('<head>', '<head><base href="https://kikivoice.ai/">');
        }
        html = html.replace(/<script>\s*\(function\(\)\{function c\(\)\{var b=a\.contentDocument[\s\S]*?<\/script>/gi, '');
        const pm = "<script>(function(){var o=typeof showSuccess==='function'?showSuccess:null;var e2=typeof showError==='function'?showError:null;window.showSuccess=function(){if(o)o();if(window.parent!==window)window.parent.postMessage({type:'geetest-success'},'*');};window.showError=function(){if(e2)e2();if(window.parent!==window)window.parent.postMessage({type:'geetest-error'},'*');};})();</script>";
        html = html.replace('</body>', pm + '</body>');
        return new Response(html, { status: resp.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Frame-Options': '' } });
      } catch (e) {
        return new Response('Geetest proxy error: ' + e.message, { status: 500, headers: corsHeaders() });
      }
    }
    // Geetest verification submission proxy
    if (path === '/api/kiki/geetest-submit') {
      try {
        let body;
        try { body = await request.json(); } catch(e) {
          return new Response(JSON.stringify({code:400,msg:'Invalid JSON body'}),{status:400,headers:{'Content-Type':'application/json',...corsHeaders()}});
        }
        const resp = await fetch(KIKA_BASE + '/jsapi/auth/geetest-validation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Origin': 'https://kikivoice.ai',
            'Referer': 'https://kikivoice.ai/ai-voice-cloning/zh-cn',
            'Cookie': 'uuid=' + kikiUuid,
          },
          body: JSON.stringify(body),
        });
        const respText = await resp.text();
        return new Response(respText, { status: resp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
};

// ==================== HTML Page Generator ====================
function getHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TTS Voice Lab v${VERSION}</title>
<style>
:root{--bg:#0f0f0f;--surface:#1a1a1a;--surface2:#242424;--surface3:#2e2e2e;--border:#333;--text:#e0e0e0;--text2:#999;--primary:#6c5ce7;--primary-hover:#7d6ff0;--green:#00b894;--orange:#fdcb6e;--red:#e17055;--blue:#74b9ff;--nv-color:#e17055;--idx-color:#74b9ff;--kk-color:#10b981}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--surface)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;flex-shrink:0}
.header-left{display:flex;align-items:center;gap:12px}
.header h1{font-size:18px;font-weight:700;background:linear-gradient(135deg,var(--primary),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .ver{font-size:11px;color:var(--text2);background:var(--surface2);padding:2px 8px;border-radius:10px}
.api-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}
.api-status .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.api-status .dot.online{background:var(--green)}
.api-status .dot.offline{background:var(--red)}
.api-status .dot.checking{background:var(--orange)}
.header-right{display:flex;gap:8px}
.hdr-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;transition:all .2s}
.hdr-btn:hover{background:var(--primary);color:#fff;border-color:var(--primary)}
.engine-selector{display:flex;gap:0;background:var(--surface2);border-radius:8px;border:1px solid var(--border);overflow:hidden;margin:0 8px}
.engine-btn{padding:6px 16px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--text2);transition:all .2s;white-space:nowrap}
.engine-btn:hover{color:var(--text)}
.engine-btn.active-nv{background:var(--nv-color);color:#fff}
.engine-btn.active-idx{background:var(--idx-color);color:#fff}
.main{flex:1;max-width:960px;margin:0 auto;padding:20px;width:100%}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.card-title{font-size:15px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.engine-badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase}
.engine-badge.nv{background:var(--nv-color);color:#fff}
.engine-badge.idx{background:var(--idx-color);color:#fff}
.upload-zone{border:2px dashed var(--border);border-radius:8px;padding:28px;text-align:center;cursor:pointer;transition:all .2s;position:relative}
.upload-zone:hover{border-color:var(--primary);background:rgba(108,92,231,0.05)}
.upload-zone.has-file{border-color:var(--green);background:rgba(0,184,148,0.05);border-style:solid}
.upload-zone .uz-icon{font-size:32px;margin-bottom:8px}
.upload-zone .uz-text{color:var(--text2);font-size:13px}
.upload-zone .uz-hint{color:var(--text2);font-size:11px;margin-top:4px;opacity:0.7}
.upload-zone .uz-filename{color:var(--green);font-weight:500;font-size:13px}
.audio-preview{margin-top:12px;display:flex;align-items:center;gap:8px}
.audio-preview audio{flex:1;height:32px}
.clear-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px}
.clear-btn:hover{border-color:var(--red);color:var(--red)}
.source-section{margin-top:14px;padding-top:14px;border-top:1px solid var(--surface2)}
.source-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.source-row label{font-size:12px;color:var(--text2);white-space:nowrap}
.source-select{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-size:12px;min-width:120px}
.save-source-row{display:flex;gap:6px}
.save-source-row input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:6px;font-size:12px}
.save-source-row button{background:var(--primary);border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap}
.source-list{margin-top:8px;max-height:160px;overflow-y:auto}
.source-item{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--surface2);border-radius:6px;margin-bottom:4px;font-size:12px;cursor:pointer;transition:background .15s;border:1px solid transparent}
.source-item:hover{background:var(--surface3)}
.source-item.active{border-color:var(--primary);background:rgba(108,92,231,0.1)}
.source-item .s-name{font-weight:500}
.source-item .s-actions{display:flex;gap:4px}
.source-item .s-actions button{background:var(--surface3);border:none;color:var(--text);padding:2px 6px;border-radius:4px;cursor:pointer;font-size:11px}
.text-area{width:100%;min-height:140px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text);font-size:14px;resize:vertical;font-family:inherit;line-height:1.7}
.text-area:focus{outline:none;border-color:var(--primary)}
.text-stats{display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--text2)}
.docx-actions{display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}
.docx-btn{display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--border);background:var(--surface2);color:var(--text);transition:background .2s}
.docx-btn:hover{background:var(--surface3)}
.docx-info{font-size:12px;color:var(--text2)}
.text-card{position:relative}
.docx-drop-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(108,92,231,0.12);border:2px dashed var(--primary);border-radius:12px;display:flex;align-items:center;justify-content:center;z-index:10;pointer-events:none;opacity:0;transition:opacity .2s}
.docx-drop-overlay.active{opacity:1}
.docx-drop-overlay p{color:var(--primary);font-size:15px;font-weight:600;padding:20px}
.gen-btn{width:100%;padding:14px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:8px}
.gen-btn:hover{background:var(--primary-hover)}
.gen-btn:active{opacity:0.9}
.gen-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none}
.gen-btn.nv-active{background:var(--nv-color)}
.gen-btn.idx-active{background:var(--idx-color)}
.cancel-btn{width:100%;padding:10px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);border-radius:8px;font-size:13px;cursor:pointer;margin-top:8px;transition:all .2s}
.cancel-btn:hover{border-color:var(--red);color:var(--red)}
.progress-bar{width:100%;height:6px;background:var(--surface3);border-radius:3px;margin-top:12px;overflow:hidden;display:none}
.progress-bar.active{display:block}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--primary),var(--blue));border-radius:3px;transition:width .3s}
.elapsed{font-size:13px;color:var(--text2);margin-top:8px;text-align:center}
.seg-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}
.seg-table th{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);color:var(--text2);font-weight:500;font-size:11px}
.seg-table td{padding:6px 10px;border-bottom:1px solid var(--surface2)}
.seg-table .seg-text{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.seg-table .seg-status{display:flex;align-items:center;gap:5px}
.seg-table .sd{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.seg-table .sd.pending{background:var(--text2)}
.seg-table .sd.cloning{background:var(--orange)}
.seg-table .sd.submitting{background:var(--orange)}
.seg-table .sd.processing{background:var(--blue)}
.seg-table .sd.done{background:var(--green)}
.seg-table .sd.error{background:var(--red)}
.seg-table .sd.cancelled{background:var(--text2);opacity:0.4}
.result-section{display:none}
.result-section.active{display:block}
.result-audio{width:100%;margin-top:12px}
.dl-btns{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.dl-btn{padding:9px 18px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--border);background:var(--surface2);color:var(--text);transition:all .2s;display:flex;align-items:center;gap:6px}
.dl-btn:hover{background:var(--surface3)}
.dl-btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.dl-btn.primary:hover{background:var(--primary-hover)}
.settings-panel{position:fixed;top:0;right:-440px;width:420px;height:100vh;background:var(--surface);border-left:1px solid var(--border);z-index:200;transition:right .3s;overflow-y:auto;padding:20px}
.settings-panel.open{right:0}
.settings-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:199;display:none}
.settings-overlay.open{display:block}
.settings-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.settings-header h2{font-size:18px;font-weight:600}
.close-btn{background:none;border:none;color:var(--text2);font-size:22px;cursor:pointer;padding:4px}
.close-btn:hover{color:var(--text)}
.settings-group{margin-bottom:20px}
.settings-group h3{font-size:13px;font-weight:600;color:var(--text2);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px}
.s-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface2)}
.s-item label{font-size:13px;color:var(--text)}
.s-item input[type="number"],.s-item input[type="text"],.s-item select{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:13px;width:130px}
.s-item select{cursor:pointer}
.s-item .wide{width:220px}
.ie-btns{display:flex;gap:8px;margin-top:12px}
.ie-btns button{flex:1;padding:9px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;font-size:13px;transition:all .2s}
.ie-btns button:hover{background:var(--surface3)}
.readme-btn{width:100%;padding:10px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);border-radius:8px;cursor:pointer;font-size:13px;transition:all .2s;text-align:center;margin-top:12px}
.readme-btn:hover{background:var(--surface3);color:var(--text)}
.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:500;display:none;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-content{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:90%;max-width:700px;max-height:80vh;overflow-y:auto;padding:24px;position:relative}
.modal-content h2{font-size:18px;font-weight:600;margin-bottom:16px;color:var(--primary)}
.modal-content h3{font-size:15px;font-weight:600;margin-top:16px;margin-bottom:8px;color:var(--text)}
.modal-content p,.modal-content li{font-size:13px;line-height:1.7;color:var(--text)}
.modal-content ul{padding-left:20px;margin-bottom:12px}
.modal-content code{background:var(--surface2);padding:1px 5px;border-radius:3px;font-size:12px;color:var(--orange)}
.modal-close{position:absolute;top:12px;right:16px;background:none;border:none;color:var(--text2);font-size:22px;cursor:pointer}
.modal-close:hover{color:var(--text)}
.history-list{max-height:65vh;overflow-y:auto}
.history-item{background:var(--surface2);border-radius:8px;padding:12px;margin-bottom:8px}
.history-item .hi-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.history-item .hi-text{font-size:14px;font-weight:500}
.history-item .hi-date{font-size:11px;color:var(--text2)}
.history-item .hi-detail{font-size:12px;color:var(--text2);line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;z-index:600;transform:translateX(120%);transition:transform .3s;max-width:360px}
.toast.show{transform:translateX(0)}
.toast.success{background:var(--green);color:#000}
.toast.error{background:var(--red);color:#fff}
.toast.info{background:var(--blue);color:#000}
.spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:inline-block;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.changelog-version{font-weight:600;color:var(--primary);margin-top:14px;margin-bottom:4px;font-size:14px}
.changelog-date{font-size:11px;color:var(--text2);margin-left:8px}
.clone-status{margin-top:8px;padding:8px 12px;background:var(--surface2);border-radius:6px;font-size:12px;color:var(--text2);display:none}
.clone-status.active{display:block}

.engine-btn.active-kk{background:var(--kk-color);color:#fff}
.engine-badge.kk{background:var(--kk-color);color:#fff}
.gen-btn.kk-active{background:var(--kk-color)}
.kk-cfg-card{display:none}.kk-cfg-card.visible{display:block}
.kk-info-box{background:var(--bg);border-radius:8px;padding:14px;margin-bottom:12px;border:1px solid var(--border);font-size:.85rem;color:var(--text2);line-height:1.8}
.kk-info-box b{color:var(--text)}.kk-info-box code{background:var(--surface2);padding:1px 6px;border-radius:4px;font-size:.8rem;color:var(--orange)}
.kk-conn-status{display:inline-flex;align-items:center;gap:6px;font-size:.85rem;font-weight:500;padding:4px 12px;border-radius:6px}
.kk-conn-status.ok{background:rgba(0,184,148,.15);color:var(--green)}.kk-conn-status.fail{background:rgba(225,112,85,.15);color:var(--red)}.kk-conn-status.pen{background:rgba(253,203,110,.15);color:var(--orange)}
.kk-conn-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.kk-conn-status.ok .kk-conn-dot{background:var(--green)}.kk-conn-status.fail .kk-conn-dot{background:var(--red)}.kk-conn-status.pen .kk-conn-dot{background:var(--orange)}
.kk-models{display:flex;gap:8px;margin-top:8px}
.kk-model{flex:1;padding:10px 12px;border-radius:8px;border:2px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer;text-align:center;transition:all .2s;font-size:.85rem}
.kk-model:hover{border-color:var(--kk-color)}.kk-model.sel{border-color:var(--kk-color);background:rgba(16,185,129,.15)}
.kk-model .mn{font-weight:600;display:block}.kk-model .md{font-size:.75rem;color:var(--text2);margin-top:2px}.kk-model .mc{font-size:.7rem;color:var(--orange);margin-top:4px}
.kk-params{background:var(--bg);border-radius:8px;padding:14px;margin-top:12px;border:1px solid var(--border)}
.kk-params .pt{font-size:.9rem;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.kk-param-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.kk-param-row label{min-width:70px;margin-bottom:0;font-size:.85rem;flex-shrink:0}
.kk-param-row input[type=range]{flex:1;min-width:120px;accent-color:var(--kk-color);height:6px}
.kk-param-row .pv{min-width:40px;text-align:right;font-size:.85rem;color:var(--kk-color);font-weight:600;font-family:monospace}
.kk-param-row select{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--text);font-size:.85rem}
.kk-param-row select:focus{outline:none;border-color:var(--kk-color)}
.kk-param-hint{font-size:.75rem;color:var(--text2);margin-left:8px}
.kk-pro-only{opacity:.4;pointer-events:none;transition:opacity .3s}
.kk-pro-only.active{opacity:1;pointer-events:auto}
.kk-quota{background:var(--bg);border-radius:8px;padding:12px 16px;margin-top:12px;border:1px solid var(--border)}
.kk-qbg{height:6px;background:var(--surface3);border-radius:3px;overflow:hidden;margin-top:8px}
.kk-qb{height:100%;border-radius:3px;transition:width .5s}
.kk-qb.g{background:linear-gradient(to right,#34d399,#22c55e)}.kk-qb.y{background:linear-gradient(to right,#fbbf24,#f59e0b)}.kk-qb.r{background:linear-gradient(to right,#f87171,#ef4444)}
.kk-qt{font-size:.8rem;color:var(--text2);margin-top:6px;display:flex;justify-content:space-between}
.cf-panel{border:2px solid var(--orange)!important;background:linear-gradient(135deg,rgba(253,203,110,.05),var(--surface))!important}
.cf-step{display:flex;gap:12px;align-items:flex-start;margin:10px 0;padding:10px;background:var(--bg);border-radius:8px}
.cf-num{min-width:28px;height:28px;border-radius:50%;background:var(--orange);color:white;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex-shrink:0}
.cf-body{flex:1}.cf-body p{margin:2px 0;font-size:.88rem}.cf-body a{color:var(--kk-color);word-break:break-all}
.cf-url-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin:8px 0;word-break:break-all;font-family:'Courier New',monospace;font-size:.82rem;color:var(--kk-color)}
.cf-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.iframe-wrap{margin-top:16px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:white;position:relative}
.iframe-wrap iframe{width:100%;height:420px;border:none}
.iframe-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(15,15,15,.8);display:flex;align-items:center;justify-content:center;z-index:10}
.iframe-overlay .inner{text-align:center;color:var(--text)}
.iframe-overlay .inner p{margin:8px 0;font-size:.9rem}
.log-console{max-height:400px;overflow-y:auto;background:var(--bg);border-radius:8px;padding:12px;font-family:'Courier New',monospace;font-size:.78rem;line-height:1.5;margin-top:12px}
.log-entry{padding:2px 0;word-break:break-all}.log-entry.i{color:var(--text2)}.log-entry.s{color:var(--green)}.log-entry.e{color:var(--red)}.log-entry.w{color:var(--orange)}

/* Speaker Assignment Styles */
.speaker-card{display:none}.speaker-card.visible{display:block}
.speaker-warning{background:rgba(253,203,110,0.1);border:1px solid var(--orange);border-radius:8px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--orange)}
.speaker-warning .sw-icon{font-size:18px;flex-shrink:0;margin-top:1px}
.speaker-warning .sw-text{flex:1;line-height:1.6}
.speaker-warning .sw-text b{color:#fff}
.speaker-warning .sw-actions{display:flex;gap:6px;margin-top:6px}
.speaker-warning .sw-actions button{padding:4px 12px;border-radius:6px;border:1px solid var(--orange);background:transparent;color:var(--orange);cursor:pointer;font-size:12px;transition:all .2s}
.speaker-warning .sw-actions button:hover{background:var(--orange);color:#000}
.speaker-list{display:flex;flex-direction:column;gap:10px}
.speaker-row{display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg);border-radius:8px;border:1px solid var(--border)}
.speaker-row .sp-color{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.speaker-row .sp-name{font-weight:600;font-size:14px;min-width:60px;flex-shrink:0}
.speaker-row .sp-stats{font-size:11px;color:var(--text2);margin-left:4px}
.speaker-row .sp-select{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;min-width:140px}
.speaker-row .sp-upload{display:flex;align-items:center;gap:6px}
.speaker-row .sp-upload-btn{background:var(--primary);border:none;color:#fff;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;transition:all .2s}
.speaker-row .sp-upload-btn:hover{background:var(--primary-hover)}
.speaker-row .sp-upload-filename{font-size:11px;color:var(--green);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-preview{font-size:11px;color:var(--text2);margin-left:4px}
.seg-speaker{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-right:4px}
.seg-speaker.sp0{background:rgba(108,92,231,0.3);color:#a29bfe}
.seg-speaker.sp1{background:rgba(0,184,148,0.3);color:#55efc4}
.seg-speaker.sp2{background:rgba(116,185,255,0.3);color:#74b9ff}
.seg-speaker.sp3{background:rgba(253,203,110,0.3);color:#fdcb6e}
.seg-speaker.sp4{background:rgba(225,112,85,0.3);color:#e17055}
.speaker-pattern-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.speaker-pattern-row input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px;font-family:monospace}
.speaker-pattern-row .sp-del{background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;padding:2px 6px}
.speaker-pattern-row .sp-del:hover{opacity:0.7}

@media(max-width:640px){.main{padding:12px}.header{padding:8px 12px;flex-wrap:wrap;gap:8px}.settings-panel{width:100%;right:-100%}.card{padding:14px}.modal-content{width:95%;padding:16px}.engine-selector{margin:4px 0}.speaker-row{flex-wrap:wrap}.speaker-row .sp-name{min-width:50px}}
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1>TTS Voice Lab</h1>
    <span class="ver">v${VERSION}</span>
    <div class="api-status">
      <span class="dot checking" id="apiDot"></span>
      <span id="apiText">检测中...</span>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="engine-selector">
      <button class="engine-btn active-nv" id="btnNV" onclick="switchEngine('nicevoice')">NiceVoice</button>
      <button class="engine-btn" id="btnIDX" onclick="switchEngine('indextts')">IndexTTS</button>
      <button class="engine-btn" id="btnKK" onclick="switchEngine('kikivoice')">KikiVoice</button>
    </div>
    <button class="hdr-btn" onclick="openHistory()">&#x1F4CB; 历史</button>
    <button class="hdr-btn" onclick="toggleSettings()">&#x2699; 设置</button>
  </div>
</div>

<div class="main">
  <!-- Card 1: Reference Audio -->
  <div class="card">
    <div class="card-title"><span class="icon">&#x1F3B5;</span> 参考音频 <span class="engine-badge nv" id="engineBadge">NV</span></div>
    <div class="upload-zone" id="uploadZone" onclick="document.getElementById('audioFile').click()" ondragover="event.preventDefault();this.style.borderColor='var(--primary)'" ondragleave="this.style.borderColor=''" ondrop="handleAudioDrop(event)">
      <div class="uz-icon">&#x1F3A4;</div>
      <div class="uz-text" id="uploadText">点击或拖拽上传参考音频</div>
      <div class="uz-hint" id="uploadHint">建议5-15秒清晰录音，支持 WAV/MP3/FLAC/M4A</div>
    </div>
    <input type="file" id="audioFile" accept="audio/*" style="display:none" onchange="handleFileUpload(event)">
    <div class="audio-preview" id="audioPreview" style="display:none">
      <audio id="previewPlayer" controls></audio>
      <button class="clear-btn" onclick="clearAudio()">&#x2716; 移除</button>
    </div>
    <div class="clone-status" id="cloneStatus"></div>
    <div class="source-section">
      <div class="source-row">
        <label>&#x1F5C2; 已保存音源:</label>
        <select class="source-select" id="sourceSelect" onchange="switchAudioSource(this.value)">
          <option value="">-- 选择音源 --</option>
        </select>
      </div>
      <div class="source-list" id="sourceList"></div>
    </div>
  </div>


  <!-- KikiVoice Config Card -->
  <div class="card kk-cfg-card" id="kkCfgCard">
    <div class="card-title">KikiVoice 配置 <span class="engine-badge kk">KK</span></div>
    <div class="kk-info-box">
      <p><b>Cloudflare + Geetest 防护机制：</b></p>
      <p>1. <b>CF CDN 挑战</b>：Worker 运行在 CF 网络内，自动绕过 CDN 层的 JS 挑战。</p>
      <p>2. <b>Geetest 人机验证</b>：首次调用 create-clone-task 时需要完成滑块验证。验证页面和提交均通过 Worker 代理，确保 IP 一致。</p>
      <p>3. <b>积分系统</b>：每 7 天重置 60,000 免费积分。Kiki Core = 2x, Kiki Pro = 3x, Kiki Multilingual = 2x。</p>
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
      <span id="kkConn" class="kk-conn-status pen"><span class="kk-conn-dot"></span>未检测</span>
      <button class="clear-btn" onclick="testKK()" style="border-color:var(--kk-color);color:var(--kk-color)">检测连接</button>
    </div>
    <div>
      <label style="display:block;font-weight:500;margin-bottom:6px;font-size:.9rem">选择模型</label>
      <div class="kk-models">
        <div class="kk-model sel" id="mCore" onclick="pickKKModel('kiki_core')"><span class="mn">Kiki Core</span><span class="md">基础克隆，稳定易用</span><span class="mc">2x credits</span></div>
        <div class="kk-model" id="mPro" onclick="pickKKModel('kiki_pro')"><span class="mn">Kiki Pro</span><span class="md">情感控制，高品质</span><span class="mc">3x credits</span></div>
        <div class="kk-model" id="mMulti" onclick="pickKKModel('kiki_multilingual')"><span class="mn">Kiki Multilingual</span><span class="md">口音转换，多语言</span><span class="mc">2x credits</span></div>
      </div>
    </div>
    <div class="kk-params" id="kkParams">
      <div class="pt">模型参数</div>
      <div class="kk-param-row">
        <label>语速 Speed</label>
        <input type="range" id="kSpeed" min="0.5" max="2.0" step="0.1" value="1.0" oninput="updKKParam()">
        <span class="pv" id="kSpeedVal">1.0</span>
        <span class="kk-param-hint">0.5慢 ~ 2.0快</span>
      </div>
      <div class="kk-param-row">
        <label>音量 Volume</label>
        <input type="range" id="kVolume" min="50" max="200" step="10" value="100" oninput="updKKParam()">
        <span class="pv" id="kVolumeVal">100</span>
        <span class="kk-param-hint">50低 ~ 200高</span>
      </div>
      <div class="kk-param-row kk-pro-only" id="emotionRow">
        <label>情感 Emotion</label>
        <select id="kEmotion" onchange="updKKParam()">
          <option value="normal">正常 Normal</option>
          <option value="happy">开心 Happy</option>
          <option value="sad">悲伤 Sad</option>
          <option value="angry">愤怒 Angry</option>
          <option value="fearful">恐惧 Fearful</option>
        </select>
        <span class="kk-param-hint">仅Pro模型</span>
      </div>
      <div class="kk-param-row kk-pro-only" id="intensityRow">
        <label>强度 Intensity</label>
        <select id="kIntensity" onchange="updKKParam()">
          <option value="normal">正常 Normal</option>
          <option value="strong">强烈 Strong</option>
          <option value="weak">轻柔 Weak</option>
        </select>
        <span class="kk-param-hint">仅Pro模型</span>
      </div>
      <div class="kk-param-row">
        <label>性别 Gender</label>
        <select id="kGender" onchange="updKKParam()">
          <option value="0">女声 Female</option>
          <option value="1">男声 Male</option>
        </select>
      </div>
      <div class="kk-param-row">
        <label>高品质 HQ</label>
        <select id="kHq" onchange="updKKParam()">
          <option value="0">标准 Standard</option>
          <option value="1">高品质 High Quality</option>
        </select>
      </div>
    </div>
    <div class="kk-quota">
      <div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:.9rem;font-weight:600">积分用量</span><span style="font-size:.8rem;color:var(--text2)" id="qReset">7天重置</span></div>
      <div class="kk-qbg"><div class="kk-qb g" id="qBar" style="width:100%"></div></div>
      <div class="kk-qt"><span>剩余: <b id="qAvail">--</b></span><span>已用: <b id="qUsed">--</b></span></div>
    </div>
  </div>

  <!-- CF Verification Panel -->
  <div class="card cf-panel" id="cfPanel" style="display:none">
    <div class="card-title" style="color:var(--orange);font-size:1.1rem">需要人机验证 (Geetest 极验)</div>
    <div class="kk-info-box" style="border-color:var(--orange)">
      <p>KikiVoice 要求完成 Geetest 人机验证后才能创建语音任务。</p>
      <p>Worker IP: <b id="cfIP" style="color:var(--orange)">--</b></p>
      <p>Session UUID: <b id="cfUUID" style="color:var(--text2);font-family:monospace;font-size:.8rem">--</b></p>
      <p style="font-size:.8rem;margin-top:4px">验证页面已通过 Worker 代理加载，验证提交也走 Worker，确保 IP 和 Session 一致。</p>
    </div>
    <div style="margin:8px 0">
      <p style="font-size:.9rem;font-weight:600;margin-bottom:8px">验证步骤：</p>
      <div class="cf-step"><div class="cf-num">1</div><div class="cf-body"><p>点击<b>滑块验证按钮</b>完成人机验证</p><p style="color:var(--text2);font-size:.8rem">验证页面已嵌入下方，直接操作即可</p></div></div>
      <div class="cf-step"><div class="cf-num">2</div><div class="cf-body"><p>看到<b>"Verification Successful"</b>后，点击下方"验证完成，继续生成"</p></div></div>
    </div>
    <div class="iframe-wrap" id="cfIframeWrap">
      <iframe id="cfIframe" src="about:blank" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
      <div class="iframe-overlay" id="cfIframeOverlay"><div class="inner"><p>验证页面加载中...</p><p style="font-size:.8rem;color:var(--text2)">如长时间无响应，请点击下方按钮在新标签页打开</p></div></div>
    </div>
    <div class="cf-actions">
      <button class="clear-btn" onclick="cfDone()" style="background:var(--kk-color);color:white;border-color:var(--kk-color)">验证完成，继续生成</button>
      <button class="clear-btn" onclick="openCFNewTab()" style="background:var(--orange);color:white;border-color:var(--orange)">在新标签页打开</button>
      <button class="clear-btn" onclick="cfCancel()">取消生成</button>
    </div>
    <div style="margin:8px 0">
      <p style="font-size:.85rem;color:var(--text2);margin-bottom:4px">验证页面 URL（代理版）：</p>
      <div class="cf-url-box" id="cfUrl">--</div>
    </div>
    <div class="log-console" style="margin-top:12px;max-height:150px">
      <div class="log-entry w" id="cfRaw">等待验证...</div>
    </div>
  </div>

  <!-- Card 2: Text Input -->
  <div class="card text-card" id="textCard">
    <div class="card-title"><span class="icon">&#x1F4DD;</span> 合成文本</div>
    <div class="docx-drop-overlay" id="docxDropOverlay"><p>&#x1F4C4; 释放 Word 文档，自动读取文本</p></div>
    <textarea class="text-area" id="textInput" placeholder="输入要合成的文本...&#10;支持长文本自动分段处理，也可拖入 Word 文档&#10;换行将保留用于字幕分行" oninput="updateTextStats()"></textarea>
    <div class="docx-actions">
      <button class="docx-btn" onclick="document.getElementById('docxFileInput').click()">&#x1F4C4; 上传 Word 文档</button>
      <span class="docx-info" id="docxInfo"></span>
    </div>
    <input type="file" id="docxFileInput" accept=".docx" style="display:none" onchange="handleDocxUpload(event)">
    <div class="text-stats">
      <span>字数: <b id="charCount">0</b></span>
      <span>行数: <b id="lineCount">0</b></span>
      <span>预计分段: <b id="segCount">0</b></span>
    </div>
  </div>

  <!-- Card 2.5: Speaker Assignment -->
  <div class="card speaker-card" id="speakerCard">
    <div class="card-title"><span class="icon">&#x1F3A4;</span> 说话人分配 <span style="font-size:11px;color:var(--text2)" id="speakerModeLabel">单人模式</span></div>
    <div class="speaker-warning" id="speakerWarning" style="display:none">
      <span class="sw-icon">&#x26A0;&#xFE0F;</span>
      <div class="sw-text" id="speakerWarningText"></div>
    </div>
    <div class="speaker-list" id="speakerList"></div>
  </div>

  <!-- Card 3: Generate -->
  <div class="card">
    <button class="gen-btn nv-active" id="generateBtn" onclick="startGenerate()">
      <span id="genBtnText">&#x1F680; 开始合成 (NiceVoice)</span>
    </button>
    <button class="cancel-btn" id="cancelBtn" onclick="cancelGenerate()" style="display:none">&#x23F9; 取消生成</button>
    <div class="progress-bar" id="progressBar">
      <div class="progress-fill" id="progressFill" style="width:0%"></div>
    </div>
    <div class="elapsed" id="elapsed" style="display:none">已用时: 0s</div>
    <table class="seg-table" id="segTable" style="display:none">
      <thead><tr><th>#</th><th>文本</th><th>状态</th><th>时长</th></tr></thead>
      <tbody id="segBody"></tbody>
    </table>
    <div class="log-console" id="logBox"></div>
  </div>

  <!-- Card 4: Results -->
  <div class="card result-section" id="resultSection">
    <div class="card-title"><span class="icon">&#x1F3B5;</span> 合成结果</div>
    <audio class="result-audio" id="resultAudio" controls></audio>
    <div class="dl-btns">
      <button class="dl-btn primary" onclick="downloadWav()">&#x1F4E5; 下载 WAV</button>
      <button class="dl-btn" onclick="downloadSrt()">&#x1F4E5; 下载 SRT</button>
      <button class="dl-btn" onclick="downloadJianYing()">&#x1F4E5; 下载剪映工程</button>
    </div>
  </div>
</div>

<!-- Settings Panel -->
<div class="settings-overlay" id="settingsOverlay" onclick="toggleSettings()"></div>
<div class="settings-panel" id="settingsPanel">
  <div class="settings-header">
    <h2>&#x2699; 设置</h2>
    <button class="close-btn" onclick="toggleSettings()">&#x2715;</button>
  </div>
  <div class="settings-group">
    <h3>引擎选择</h3>
    <div class="s-item"><label>TTS 引擎</label>
      <select id="cfgEngine" onchange="switchEngine(this.value)">
        <option value="nicevoice">NiceVoice (推荐)</option>
        <option value="indextts">IndexTTS</option>
        <option value="kikivoice">KikiVoice (备选)</option>
      </select>
    </div>
  </div>
  <div class="settings-group" id="nvSettings">
    <h3>NiceVoice 设置</h3>
    <div class="s-item"><label>请求间隔 (秒)</label><input type="number" id="cfgNvWait" min="10" max="30" step="1"></div>
    <div class="s-item"><label>最大字数/段</label><input type="number" id="cfgNvMaxChars" min="50" max="150"></div>
    <div class="s-item"><label>最大轮询次数</label><input type="number" id="cfgNvMaxPoll" min="20" max="120"></div>
  </div>
  <div class="settings-group" id="idxSettings" style="display:none">
    <h3>IndexTTS 设置</h3>
    <div class="s-item"><label>API 地址</label><input type="text" id="cfgApiBase" class="wide"></div>
    <div class="s-item"><label>语言</label>
      <select id="cfgLanguage">
        <option value="zh">中文</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
        <option value="ko">한국어</option>
      </select>
    </div>
    <div class="s-item"><label>最大字数/段</label><input type="number" id="cfgMaxChars" min="50" max="1000"></div>
    <div class="s-item"><label>并发数 (1-5)</label><input type="number" id="cfgConcurrency" min="1" max="5"></div>
    <div class="s-item"><label>重试次数</label><input type="number" id="cfgRetry" min="0" max="5"></div>
    <div class="s-item"><label>轮询间隔 (ms)</label><input type="number" id="cfgPollInterval" min="500" max="10000" step="500"></div>
  </div>
  <div class="settings-group" id="kkSettings" style="display:none">
    <h3>KikiVoice 设置</h3>
    <div class="s-item"><label>连接状态</label><span id="kkSettingsConn" style="font-size:13px;color:var(--text2)">未检测</span></div>
    <div class="s-item"><label>当前模型</label><span id="kkSettingsModel" style="font-size:13px;color:var(--text2)">kiki_core</span></div>
  </div>
  <div class="settings-group">
    <h3>音源管理</h3>
    <div class="save-source-row" style="margin-bottom:8px">
      <input type="text" id="saveSourceName" placeholder="音源名称（如: 播音腔）">
      <button onclick="saveCurrentAudioSource()">保存当前音源</button>
    </div>
    <div class="source-list" id="settingsSourceList"></div>
  </div>
  <div class="settings-group">
    <h3>说话人识别模式</h3>
    <div class="s-item" style="flex-direction:column;align-items:flex-start;gap:8px">
      <label style="font-size:12px;color:var(--text2)">内置模式（无需配置）</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" id="cfgSpBracket" checked> 【姓名】格式</label>
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="checkbox" id="cfgSpColon" checked> 姓名：格式</label>
      </div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text2);display:block;margin-bottom:6px">自定义说话人正则模式 <span style="font-size:11px;opacity:0.7">（匹配后的第一个捕获组为说话人名）</span></label>
      <div id="speakerPatternsList"></div>
      <div class="save-source-row" style="margin-top:6px">
        <input type="text" id="newSpeakerPattern" placeholder="如: ^(\\\\S+?)\\\\s*>>>\\\\s*">
        <button onclick="addSpeakerPattern()">添加模式</button>
      </div>
    </div>
    <div class="s-item" style="margin-top:8px"><label>防呆阈值（比例）</label><input type="number" id="cfgSpBalance" min="2" max="10" step="1" style="width:80px"></div>
  </div>
  <div class="settings-group">
    <h3>历史记录</h3>
    <div class="s-item"><label>最大保存条数</label><input type="number" id="cfgMaxHistory" min="1" max="50"></div>
  </div>
  <div class="settings-group">
    <h3>导入/导出</h3>
    <div class="ie-btns">
      <button onclick="exportConfig()">&#x1F4E4; 导出配置</button>
      <button onclick="document.getElementById('importFile').click()">&#x1F4E5; 导入配置</button>
    </div>
    <input type="file" id="importFile" accept=".json" style="display:none" onchange="importConfig(event)">
  </div>
  <div class="settings-group" style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
    <button class="readme-btn" onclick="showReadme()">&#x1F4D6; 查看 README 与更新日志 (v${VERSION})</button>
  </div>
</div>

<!-- History Modal -->
<div class="modal-overlay" id="historyModal">
  <div class="modal-content">
    <button class="modal-close" onclick="closeHistory()">&#x00D7;</button>
    <h2>&#x1F4CB; 生成历史</h2>
    <div class="history-list" id="historyList"></div>
  </div>
</div>

<!-- README Modal -->
<div class="modal-overlay" id="readmeModal">
  <div class="modal-content">
    <button class="modal-close" onclick="closeReadme()">&#x00D7;</button>
    <div id="readmeBody"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// ==================== Constants & State ====================
var APP_VERSION = '${VERSION}';
var DEFAULT_API = '${DEFAULT_INDEX_API}';

var S = {
  engine: 'nicevoice',  // 'nicevoice' | 'indextts' | 'kikivoice'
  audioFile: null,       // { name, dataUrl, base64, wavBlob }
  audioSources: [],
  activeSourceId: '',
  segments: [],
  segmentBuffers: [],
  segmentDurations: [],
  resultWavBlob: null,
  resultSrt: '',
  resultWavUrl: null,     // Object URL for playback, reuse for download
  isGenerating: false,
  cancelRequested: false,
  elapsedTimer: null,
  elapsedStart: 0,
  downloadTimestamp: '',
  docxFileName: '',       // e.g. "0525 韩星见面会" (without .docx extension)
  projectName: '',        // for file naming: docxFileName or timestamp
  // NiceVoice state
  nvReferenceId: null,   // trained voice clone ID
  nvCloneBusy: false,
  // KikiVoice state
  kkUuid: 'vc-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2,8),
  kkModel: 'kiki_core',
  kkConnected: false,
  kkCaps: null,
  kkVoiceId: null,
  kkQuota: { a: 60000, u: 0, m: 60000, r: 7 },
  cfResolve: null,
  cfReject: null,
  cfProxyUrl: '',
  cfDirectUrl: '',
  // Speaker state
  speakerMode: 'single',  // 'single' | 'multi'
  detectedSpeakers: [],    // [{name, lineCount, charCount}]
  speakerAssignments: {},  // { '小娱': sourceId, '乐乐': sourceId }
  speakerVoiceData: {},    // { '小娱': { audioFile, nvReferenceId }, ... } - populated during generation
  // Config
  config: {
    engine: 'nicevoice',
    // NiceVoice
    nvWait: 16,
    nvMaxChars: 150,
    nvMaxPoll: 60,
    // IndexTTS
    apiBase: DEFAULT_API,
    language: 'zh',
    maxChars: 250,
    concurrency: 1,
    retryCount: 2,
    pollInterval: 2000,
    // History
    maxHistory: 10,
    // Speaker patterns
    spBracket: true,     // enable 【name】 pattern
    spColon: true,       // enable name: pattern
    spCustomPatterns: [], // custom regex patterns (strings)
    spBalanceThreshold: 5, // anti-fool ratio threshold
  }
};

// ==================== JSZip Async Loader ====================
var _jszipPromise = null;
function loadJSZip() {
  if (!_jszipPromise) {
    _jszipPromise = new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = resolve;
      s.onerror = function() { reject(new Error('Failed to load JSZip')); };
      document.head.appendChild(s);
    });
  }
  return _jszipPromise;
}

var E = {};
function cacheElements() {
  ['apiDot','apiText','btnNV','btnIDX','engineBadge','generateBtn','genBtnText',
   'nvSettings','idxSettings','cfgEngine','uploadZone','audioPreview','previewPlayer',
   'uploadText','uploadHint','sourceSelect','sourceList','settingsSourceList',
   'textInput','charCount','lineCount','segCount','docxInfo','docxDropOverlay',
   'textCard','cloneStatus','cancelBtn','progressBar','progressFill','elapsed',
   'segTable','segBody','resultSection','resultAudio','settingsPanel','settingsOverlay',
   'saveSourceName','historyModal','historyList','readmeModal','readmeBody','toast',
   'cfgNvWait','cfgNvMaxChars','cfgNvMaxPoll','cfgApiBase','cfgLanguage','btnKK','kkCfgCard','kkConn','kkSettings','logBox','cfPanel','cfIP','cfUUID','cfUrl','cfIframe','cfIframeOverlay','cfRaw',
   'cfgMaxChars','cfgConcurrency','cfgRetry','cfgPollInterval','cfgMaxHistory',
   'speakerCard','speakerList','speakerWarning','speakerWarningText','speakerModeLabel',
   'cfgSpBracket','cfgSpColon','speakerPatternsList','cfgSpBalance'
  ].forEach(function(id) { E[id] = document.getElementById(id); });
}

// ==================== Init ====================
window.addEventListener('DOMContentLoaded', function() {
  cacheElements();
  loadConfig();
  loadAudioSources();
  checkApiStatus();
  initDocxDragDrop();
  updateTextStats();
  applyConfigToUI();
  switchEngine(S.config.engine || 'nicevoice');
});

// ==================== Engine Switching ====================
function switchEngine(eng) {
  S.engine = eng;
  S.config.engine = eng;
  var btnNV = E.btnNV;
  var btnIDX = E.btnIDX;
  var btnKK = E.btnKK;
  var badge = E.engineBadge;
  var genBtn = E.generateBtn;
  var genBtnText = E.genBtnText;
  var nvSettings = E.nvSettings;
  var idxSettings = E.idxSettings;
  var kkSettings = E.kkSettings;
  var kkCfgCard = E.kkCfgCard;
  var cfgEngine = E.cfgEngine;

  btnNV.className = 'engine-btn' + (eng === 'nicevoice' ? ' active-nv' : '');
  btnIDX.className = 'engine-btn' + (eng === 'indextts' ? ' active-idx' : '');
  if (btnKK) btnKK.className = 'engine-btn' + (eng === 'kikivoice' ? ' active-kk' : '');

  if (nvSettings) nvSettings.style.display = 'none';
  if (idxSettings) idxSettings.style.display = 'none';
  if (kkSettings) kkSettings.style.display = 'none';
  if (kkCfgCard) kkCfgCard.className = 'card kk-cfg-card';

  if (eng === 'nicevoice') {
    badge.textContent = 'NV';
    badge.className = 'engine-badge nv';
    genBtn.className = 'gen-btn nv-active';
    genBtnText.innerHTML = '&#x1F680; 开始合成 (NiceVoice)';
    if (nvSettings) nvSettings.style.display = '';
  } else if (eng === 'indextts') {
    badge.textContent = 'IDX';
    badge.className = 'engine-badge idx';
    genBtn.className = 'gen-btn idx-active';
    genBtnText.innerHTML = '&#x1F680; 开始合成 (IndexTTS)';
    if (idxSettings) idxSettings.style.display = '';
  } else if (eng === 'kikivoice') {
    badge.textContent = 'KK';
    badge.className = 'engine-badge kk';
    genBtn.className = 'gen-btn kk-active';
    genBtnText.innerHTML = '&#x1F680; 开始合成 (KikiVoice)';
    if (kkSettings) kkSettings.style.display = '';
    if (kkCfgCard) kkCfgCard.className = 'card kk-cfg-card visible';
    // Auto-detect KikiVoice connection when switching to this engine
    if (!S.kkConnected) {
      setTimeout(function() { testKK(); }, 300);
    }
  }

  if (cfgEngine) cfgEngine.value = eng;
  updateTextStats();
  checkApiStatus();
}

// ==================== API Status Check ====================
async function checkApiStatus() {
  var dot = E.apiDot;
  var txt = E.apiText;
  dot.className = 'dot checking';
  txt.textContent = '检测中...';

  if (S.engine === 'nicevoice') {
    // Check NiceVoice API
    try {
      var resp = await fetch('/api/nv/getUploadUrl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suffix: '.wav' })
      });
      if (resp.ok) {
        var data = await resp.json();
        if (data.data && (data.data.url || data.data.uploadUrl)) {
          dot.className = 'dot online';
          txt.textContent = 'NiceVoice 在线';
        } else if (data.code !== undefined) {
          dot.className = 'dot online';
          txt.textContent = 'NiceVoice 在线';
        } else {
          dot.className = 'dot offline';
          txt.textContent = 'NiceVoice 响应异常';
        }
      } else {
        dot.className = 'dot offline';
        txt.textContent = 'NiceVoice 不可达';
      }
    } catch(e) {
      dot.className = 'dot offline';
      txt.textContent = 'NiceVoice 不可达';
    }
  } else if (S.engine === 'indextts') {
    // Check IndexTTS API
    try {
      var ctrl = new AbortController();
      var tid = setTimeout(function() { ctrl.abort(); }, 8000);
      var resp = await fetch(S.config.apiBase + '/', { signal: ctrl.signal });
      clearTimeout(tid);
      if (resp.ok) {
        var data = await resp.json();
        if (data.name || data.endpoints) {
          dot.className = 'dot online';
          txt.textContent = 'IndexTTS 在线';
        } else {
          dot.className = 'dot offline';
          txt.textContent = 'API 响应异常';
        }
      } else {
        dot.className = 'dot offline';
        txt.textContent = 'API 异常 (' + resp.status + ')';
      }
    } catch(e) {
      dot.className = 'dot offline';
      txt.textContent = 'API 不可达';
    }
  } else if (S.engine === 'kikivoice') {
    try {
      var ctrl = new AbortController();
      var tid = setTimeout(function() { ctrl.abort(); }, 8000);
      var resp = await fetch('/api/kiki/model-capabilities?uuid=' + encodeURIComponent(S.kkUuid), { signal: ctrl.signal });
      clearTimeout(tid);
      if (resp.ok) {
        var data = await resp.json();
        if (data.error_code === 0) {
          S.kkConnected = true; S.kkCaps = data;
          dot.className = 'dot online';
          txt.textContent = 'KikiVoice 在线';
          // Update KK connection status UI
          var cs = document.getElementById('kkConn');
          if (cs) { cs.className = 'kk-conn-status ok'; cs.innerHTML = '<span class="kk-conn-dot"></span>已连接'; }
          // Update model credit rates
          var c = data.model_capabilities || {};
          if (c.kiki_core) { var el = document.querySelector('#mCore .mc'); if (el) el.textContent = c.kiki_core.credit_rate + 'x'; }
          if (c.kiki_pro) { var el = document.querySelector('#mPro .mc'); if (el) el.textContent = c.kiki_pro.credit_rate + 'x'; }
          if (c.kiki_multilingual && c.kiki_multilingual.credit_rates && c.kiki_multilingual.credit_rates.v2) { var el = document.querySelector('#mMulti .mc'); if (el) el.textContent = c.kiki_multilingual.credit_rates.v2.rate + 'x'; }
          // Update quota info from capabilities response
          if (data.available_count !== undefined || data.user_tts_available_count !== undefined) {
            updKKQuota(data);
          }
        } else {
          S.kkConnected = false;
          dot.className = 'dot offline';
          txt.textContent = 'KikiVoice 不可用';
          var cs = document.getElementById('kkConn');
          if (cs) { cs.className = 'kk-conn-status fail'; cs.innerHTML = '<span class="kk-conn-dot"></span>失败'; }
        }
      } else {
        dot.className = 'dot offline';
        txt.textContent = 'KikiVoice 不可达';
        var cs = document.getElementById('kkConn');
        if (cs) { cs.className = 'kk-conn-status fail'; cs.innerHTML = '<span class="kk-conn-dot"></span>不可达'; }
      }
    } catch(e) {
      dot.className = 'dot offline';
      txt.textContent = 'KikiVoice 不可达';
      var cs = document.getElementById('kkConn');
      if (cs) { cs.className = 'kk-conn-status fail'; cs.innerHTML = '<span class="kk-conn-dot"></span>错误'; }
    }
  }
}

// ==================== DOCX Processing ====================
function initDocxDragDrop() {
  var card = E.textCard;
  var overlay = E.docxDropOverlay;
  var dragCounter = 0;
  card.addEventListener('dragenter', function(e) { e.preventDefault(); e.stopPropagation(); dragCounter++; overlay.classList.add('active'); });
  card.addEventListener('dragleave', function(e) { e.preventDefault(); e.stopPropagation(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('active'); } });
  card.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); });
  card.addEventListener('drop', function(e) {
    e.preventDefault(); e.stopPropagation(); dragCounter = 0; overlay.classList.remove('active');
    var files = e.dataTransfer.files;
    if (files.length > 0) {
      var file = files[0];
      if (file.name.endsWith('.docx')) { processDocxFile(file); }
      else if (file.type.startsWith('audio/')) { /* handled by audio zone */ }
      else { showToast('请拖入 .docx 格式的 Word 文档', 'error'); }
    }
  });
}

function handleDocxUpload(event) {
  var file = event.target.files[0];
  if (!file) return;
  if (!file.name.endsWith('.docx')) { showToast('请选择 .docx 格式的 Word 文档', 'error'); event.target.value = ''; return; }
  processDocxFile(file);
  event.target.value = '';
}

async function processDocxFile(file) {
  await loadJSZip();
  showToast('正在解析 Word 文档...', 'info');
  try {
    var arrayBuffer = await file.arrayBuffer();
    var zip = await JSZip.loadAsync(arrayBuffer);
    var docXml = await zip.file('word/document.xml').async('string');
    var parser = new DOMParser();
    var xmlDoc = parser.parseFromString(docXml, 'application/xml');
    var textParts = extractLeftColumnText(xmlDoc);
    if (textParts.length === 0) {
      var allText = extractAllParagraphText(xmlDoc);
      if (allText) {
        E.textInput.value = allText;
        updateTextStats();
        showToast('未找到表格，已提取全部文本', 'info');
      } else {
        showToast('文档中未找到可用文本', 'error'); return;
      }
    } else {
      var fullText = textParts.join('\\n');
      E.textInput.value = fullText;
      updateTextStats();
      showToast('已读取表格左列文本，共 ' + textParts.length + ' 段', 'success');
    }
    E.docxInfo.textContent = file.name;
    // Store docx filename (without .docx) for project naming
    S.docxFileName = file.name.replace(/\.docx$/i, '');
  } catch(err) {
    showToast('解析 Word 文档失败: ' + err.message, 'error');
  }
}

function extractXmlText(element, ns) {
  var paragraphs = element.getElementsByTagNameNS(ns, 'p');
  var lines = [];
  for (var p = 0; p < paragraphs.length; p++) {
    var runs = paragraphs[p].getElementsByTagNameNS(ns, 'r');
    var lineText = '';
    for (var r = 0; r < runs.length; r++) {
      var texts = runs[r].getElementsByTagNameNS(ns, 't');
      for (var t = 0; t < texts.length; t++) lineText += texts[t].textContent || '';
    }
    lines.push(lineText);
  }
  return lines;
}

function extractLeftColumnText(xmlDoc) {
  var ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var parts = [];
  var tables = xmlDoc.getElementsByTagNameNS(ns, 'tbl');
  for (var t = 0; t < tables.length; t++) {
    var rows = tables[t].getElementsByTagNameNS(ns, 'tr');
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].getElementsByTagNameNS(ns, 'tc');
      if (cells.length >= 1) {
        var cellText = getCellText(cells[0], ns);
        if (cellText.trim()) parts.push(cellText.trim());
      }
    }
  }
  return parts;
}

function getCellText(tcElement, ns) {
  return extractXmlText(tcElement, ns).join('\\n');
}

function extractAllParagraphText(xmlDoc) {
  var ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var lines = extractXmlText(xmlDoc, ns);
  var filtered = [];
  for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) filtered.push(lines[i].trim()); }
  return filtered.join('\\n');
}

// ==================== Config Management ====================
function loadConfig() {
  try {
    var saved = localStorage.getItem('ttsvoicelab_config');
    if (saved) {
      var c = JSON.parse(saved);
      Object.keys(c).forEach(function(k) { if (S.config[k] !== undefined) S.config[k] = c[k]; });
    }
  } catch(e) {}
  S.engine = S.config.engine || 'nicevoice';
}

function saveConfig() {
  readConfigFromUI();
  try { localStorage.setItem('ttsvoicelab_config', JSON.stringify(S.config)); } catch(e) {}
}

function applyConfigToUI() {
  var c = S.config;
  var el;
  el = E.cfgEngine; if (el) el.value = c.engine || 'nicevoice';
  el = E.cfgNvWait; if (el) el.value = c.nvWait || 16;
  el = E.cfgNvMaxChars; if (el) el.value = c.nvMaxChars || 150;
  el = E.cfgNvMaxPoll; if (el) el.value = c.nvMaxPoll || 60;
  el = E.cfgApiBase; if (el) el.value = c.apiBase;
  el = E.cfgLanguage; if (el) el.value = c.language;
  el = E.cfgMaxChars; if (el) el.value = c.maxChars;
  el = E.cfgConcurrency; if (el) el.value = c.concurrency;
  el = E.cfgRetry; if (el) el.value = c.retryCount;
  el = E.cfgPollInterval; if (el) el.value = c.pollInterval;
  el = E.cfgMaxHistory; if (el) el.value = c.maxHistory || 10;
  el = E.cfgSpBracket; if (el) el.checked = c.spBracket !== false;
  el = E.cfgSpColon; if (el) el.checked = c.spColon !== false;
  el = E.cfgSpBalance; if (el) el.value = c.spBalanceThreshold || 5;
  renderSpeakerPatterns();
}

function readConfigFromUI() {
  var c = S.config;
  c.engine = E.cfgEngine.value || 'nicevoice';
  c.nvWait = parseInt(E.cfgNvWait.value) || 16;
  c.nvMaxChars = parseInt(E.cfgNvMaxChars.value) || 150;
  c.nvMaxPoll = parseInt(E.cfgNvMaxPoll.value) || 60;
  c.apiBase = (E.cfgApiBase.value || '').trim() || DEFAULT_API;
  c.language = E.cfgLanguage.value || 'zh';
  c.maxChars = parseInt(E.cfgMaxChars.value) || 250;
  c.concurrency = Math.max(1, Math.min(5, parseInt(E.cfgConcurrency.value) || 1));
  c.retryCount = parseInt(E.cfgRetry.value) || 2;
  c.pollInterval = parseInt(E.cfgPollInterval.value) || 2000;
  c.maxHistory = Math.max(1, parseInt(E.cfgMaxHistory.value) || 10);
  c.spBracket = E.cfgSpBracket ? E.cfgSpBracket.checked : true;
  c.spColon = E.cfgSpColon ? E.cfgSpColon.checked : true;
  c.spBalanceThreshold = parseInt(E.cfgSpBalance ? E.cfgSpBalance.value : 5) || 5;
}

// ==================== Audio Source Management ====================
function loadAudioSources() {
  try {
    var saved = localStorage.getItem('ttsvoicelab_sources');
    if (saved) S.audioSources = JSON.parse(saved);
  } catch(e) {}
  renderSourceList();
  renderSourceSelect();
}

function saveAudioSources() {
  try { localStorage.setItem('ttsvoicelab_sources', JSON.stringify(S.audioSources)); } catch(e) {}
}

function renderSourceList() {
  var el = E.sourceList;
  var settingsEl = E.settingsSourceList;
  if (!S.audioSources.length) {
    var emptyHtml = '<div style="font-size:12px;color:var(--text2);padding:6px">暂无保存的音源</div>';
    if (el) el.innerHTML = emptyHtml;
    if (settingsEl) settingsEl.innerHTML = emptyHtml;
    return;
  }
  var html = '';
  var settingsHtml = '';
  S.audioSources.forEach(function(src) {
    var isActive = S.activeSourceId === src.id;
    html += '<div class="source-item' + (isActive ? ' active' : '') + '" onclick="loadAudioSource(\\'' + src.id + '\\')">';
    html += '<span class="s-name">' + escHtml(src.name) + '</span>';
    html += '</div>';
    settingsHtml += '<div class="source-item' + (isActive ? ' active' : '') + '">';
    settingsHtml += '<span class="s-name">' + escHtml(src.name) + '</span>';
    settingsHtml += '<span class="s-actions"><button onclick="event.stopPropagation();loadAudioSource(\\'' + src.id + '\\')" title="使用此音源" style="color:var(--green)">使用</button><button onclick="event.stopPropagation();deleteAudioSource(\\'' + src.id + '\\')" title="删除">&#x2716;</button></span>';
    settingsHtml += '</div>';
  });
  if (el) el.innerHTML = html;
  if (settingsEl) settingsEl.innerHTML = settingsHtml;
}

function renderSourceSelect() {
  var sel = E.sourceSelect;
  var val = sel.value;
  sel.innerHTML = '<option value="">-- 选择音源 --</option>';
  S.audioSources.forEach(function(src) {
    var opt = document.createElement('option');
    opt.value = src.id;
    opt.textContent = src.name;
    sel.appendChild(opt);
  });
  sel.value = val || S.activeSourceId || '';
}

function switchAudioSource(id) {
  if (!id) { S.activeSourceId = ''; return; }
  loadAudioSource(id);
}

function loadAudioSource(id) {
  var src = S.audioSources.find(function(s) { return s.id === id; });
  if (!src) return;
  S.activeSourceId = id;
  S.audioFile = { name: src.name + '.wav', dataUrl: src.dataUrl, base64: src.dataUrl.split(',')[1] };
  S.nvReferenceId = src.nvReferenceId || null;
  updateAudioUI();
  renderSourceList();
  renderSourceSelect();
  E.sourceSelect.value = id;
  showToast('已加载音源: ' + src.name, 'success');
}

function saveCurrentAudioSource() {
  if (!S.audioFile || !S.audioFile.dataUrl) { showToast('请先上传参考音频', 'error'); return; }
  var name = E.saveSourceName.value.trim();
  if (!name) { showToast('请输入音源名称', 'error'); return; }
  var existing = S.audioSources.find(function(s) { return s.name === name; });
  if (existing) {
    existing.dataUrl = S.audioFile.dataUrl;
    existing.nvReferenceId = S.nvReferenceId;
    existing.addedAt = Date.now();
    showToast('已更新音源: ' + name, 'success');
  } else {
    S.audioSources.push({
      id: hexId(),
      name: name,
      dataUrl: S.audioFile.dataUrl,
      nvReferenceId: S.nvReferenceId,
      addedAt: Date.now()
    });
    showToast('已保存音源: ' + name, 'success');
  }
  S.activeSourceId = S.audioSources[S.audioSources.length - 1].id;
  saveAudioSources();
  renderSourceList();
  renderSourceSelect();
  E.saveSourceName.value = '';
}

function deleteAudioSource(id) {
  S.audioSources = S.audioSources.filter(function(s) { return s.id !== id; });
  if (S.activeSourceId === id) S.activeSourceId = '';
  saveAudioSources();
  renderSourceList();
  renderSourceSelect();
  showToast('已删除音源', 'info');
}

// ==================== Audio Upload & Preview ====================
function handleFileUpload(event) {
  var file = event.target.files[0];
  if (!file) return;
  loadAudioFile(file);
  event.target.value = '';
}

function handleAudioDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  var files = event.dataTransfer.files;
  if (files.length > 0 && files[0].type.startsWith('audio/')) {
    loadAudioFile(files[0]);
  }
}

function loadAudioFile(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    var dataUrl = e.target.result;
    var base64 = dataUrl.split(',')[1];
    S.audioFile = { name: file.name, dataUrl: dataUrl, base64: base64 };
    S.nvReferenceId = null; // reset clone ID when new audio uploaded
    S.kkVoiceId = null; // reset KikiVoice voice ID
    updateAudioUI();
    showToast('已加载音频: ' + file.name + '，正在优化...', 'info');
    trimAndOptimizeAudio(dataUrl, file.name);
  };
  reader.readAsDataURL(file);
}

async function trimAndOptimizeAudio(dataUrl, fileName) {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    var resp = await fetch(dataUrl);
    var arrayBuffer = await resp.arrayBuffer();
    var decoded = await ctx.decodeAudioData(arrayBuffer);
    var duration = decoded.duration;
    var trimDuration = Math.min(duration, 10);
    var trimSamples = Math.floor(trimDuration * 24000);
    var channelData = decoded.getChannelData(0);
    if (trimSamples < channelData.length) {
      channelData = channelData.slice(0, trimSamples);
    }
    var trimBuffer = ctx.createBuffer(1, channelData.length, 24000);
    trimBuffer.copyToChannel(channelData, 0);
    var wavBlob = audioBufferToWav(trimBuffer);
    S.audioFile.wavBlob = wavBlob;
    ctx.close();

    var reader2 = new FileReader();
    reader2.onload = function(ev) {
      var optDataUrl = ev.target.result;
      var optBase64 = optDataUrl.split(',')[1];
      S.audioFile = { name: fileName, dataUrl: optDataUrl, base64: optBase64, wavBlob: wavBlob };
      updateAudioUI();
      var player = E.previewPlayer;
      if (player) player.src = optDataUrl;
      var sizeMB = (wavBlob.size / 1024 / 1024).toFixed(1);
      showToast('音频已优化（' + trimDuration.toFixed(1) + '秒，' + sizeMB + 'MB）', 'success');
    };
    reader2.readAsDataURL(wavBlob);
  } catch(err) {
    showToast('音频优化失败，使用原始文件', 'info');
  }
}

function updateAudioUI() {
  var zone = E.uploadZone;
  var preview = E.audioPreview;
  var player = E.previewPlayer;
  var uploadText = E.uploadText;
  var uploadHint = E.uploadHint;

  if (S.audioFile) {
    zone.classList.add('has-file');
    uploadText.innerHTML = '<span class="uz-filename">&#x2705; ' + escHtml(S.audioFile.name) + '</span>';
    uploadHint.textContent = '点击更换音频';
    player.src = S.audioFile.dataUrl;
    preview.style.display = 'flex';
  } else {
    zone.classList.remove('has-file');
    uploadText.textContent = '点击或拖拽上传参考音频';
    uploadHint.textContent = '建议5-15秒清晰录音，支持 WAV/MP3/FLAC/M4A';
    player.src = '';
    preview.style.display = 'none';
  }
}

function clearAudio() {
  S.audioFile = null;
  S.activeSourceId = '';
  S.nvReferenceId = null;
  updateAudioUI();
  renderSourceList();
  renderSourceSelect();
  E.sourceSelect.value = '';
  E.cloneStatus.style.display = 'none';
}

// ==================== Text Processing ====================
function updateTextStats() {
  var text = E.textInput.value;
  var chars = text.length;
  var lines = text ? text.split('\\n').length : 0;
  E.charCount.textContent = chars;
  E.lineCount.textContent = lines;
  var maxChars = S.engine === 'nicevoice' ? (S.config.nvMaxChars || 150) : S.engine === 'kikivoice' ? kkMaxChars() : (S.config.maxChars || 250);
  // Detect speakers first
  detectSpeakers(text);
  // Split text for segment count
  if (S.speakerMode === 'multi') {
    var totalSegs = 0;
    var spSegs = splitTextBySpeakers(text, maxChars);
    for (var si = 0; si < spSegs.length; si++) totalSegs += spSegs[si].segments.length;
    E.segCount.textContent = totalSegs;
  } else {
    var segs = splitTextForTTS(text, maxChars);
    E.segCount.textContent = segs.length;
  }
}

// ==================== Speaker Detection & Parsing ====================
var SPEAKER_COLORS = ['#a29bfe', '#55efc4', '#74b9ff', '#fdcb6e', '#e17055', '#fd79a8', '#6c5ce7', '#00b894'];

function getSpeakerPatterns() {
  var patterns = [];
  // Built-in 【name】 pattern
  if (S.config.spBracket !== false) {
    patterns.push({ regex: /^【(.+?)】\s*/, name: '【姓名】' });
  }
  // Built-in name: pattern
  if (S.config.spColon !== false) {
    patterns.push({ regex: /^([^\\s：:]{1,8})[：:]\s*/, name: '姓名：' });
  }
  // Custom patterns
  var customs = S.config.spCustomPatterns || [];
  for (var ci = 0; ci < customs.length; ci++) {
    try {
      patterns.push({ regex: new RegExp(customs[ci]), name: '自定义', custom: true });
    } catch(e) {}
  }
  return patterns;
}

function detectSpeakers(text) {
  if (!text || !text.trim()) {
    S.speakerMode = 'single';
    S.detectedSpeakers = [];
    updateSpeakerUI();
    return;
  }

  var patterns = getSpeakerPatterns();
  if (patterns.length === 0) {
    S.speakerMode = 'single';
    S.detectedSpeakers = [];
    updateSpeakerUI();
    return;
  }

  var lines = text.split('\\n');
  var speakerMap = {};
  var currentSpeaker = null;
  var firstSpeakerFound = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var matched = false;

    for (var pi = 0; pi < patterns.length; pi++) {
      var match = line.match(patterns[pi].regex);
      if (match && match[1]) {
        var name = match[1].trim();
        if (name && name.length <= 8 && name.length > 0) {
          currentSpeaker = name;
          firstSpeakerFound = true;
          var content = line.replace(patterns[pi].regex, '').trim();
          if (!speakerMap[name]) speakerMap[name] = { name: name, lineCount: 0, charCount: 0 };
          speakerMap[name].lineCount++;
          speakerMap[name].charCount += content.length;
          matched = true;
          break;
        }
      }
    }

    if (!matched && firstSpeakerFound && currentSpeaker) {
      // Line without speaker marker = continuation of previous speaker
      speakerMap[currentSpeaker].lineCount++;
      speakerMap[currentSpeaker].charCount += line.trim().length;
    }
  }

  var speakers = Object.values(speakerMap);
  if (speakers.length >= 2) {
    S.speakerMode = 'multi';
    S.detectedSpeakers = speakers;
    checkSpeakerBalance(speakers);
  } else if (speakers.length === 1 && firstSpeakerFound) {
    // Only one speaker detected but markers present - could be single speaker
    S.speakerMode = 'single';
    S.detectedSpeakers = speakers;
    // Still warn if only one speaker found with markers
    E.speakerWarning.style.display = 'flex';
    E.speakerWarningText.innerHTML = '检测到说话人标记，但只找到一个说话人 <b>' + escHtml(speakers[0].name) + '</b>。如果是多人文案，请检查是否遗漏了说话人标记。';
  } else {
    S.speakerMode = 'single';
    S.detectedSpeakers = [];
    E.speakerWarning.style.display = 'none';
  }

  updateSpeakerUI();
}

function checkSpeakerBalance(speakers) {
  var threshold = S.config.spBalanceThreshold || 5;
  if (speakers.length < 2) return;

  // Find max and min char counts
  var maxChars = 0, minChars = Infinity, maxName = '', minName = '';
  for (var i = 0; i < speakers.length; i++) {
    if (speakers[i].charCount > maxChars) { maxChars = speakers[i].charCount; maxName = speakers[i].name; }
    if (speakers[i].charCount < minChars) { minChars = speakers[i].charCount; minName = speakers[i].name; }
  }

  if (minChars > 0 && (maxChars / minChars) > threshold) {
    E.speakerWarning.style.display = 'flex';
    E.speakerWarningText.innerHTML = '<b>' + escHtml(maxName) + '</b> 的内容量（' + maxChars + '字）远多于 <b>' + escHtml(minName) + '</b>（' + minChars + '字），比例约 ' + Math.round(maxChars / minChars) + ':1。是否忘记在后续段落中标注说话人？<div class="sw-actions"><button onclick="dismissSpeakerWarning()">我已确认，继续</button></div>';
  } else {
    E.speakerWarning.style.display = 'none';
  }
}

function dismissSpeakerWarning() {
  E.speakerWarning.style.display = 'none';
}

function updateSpeakerUI() {
  var card = E.speakerCard;
  var label = E.speakerModeLabel;

  if (S.speakerMode === 'multi') {
    card.classList.add('visible');
    label.textContent = '多人模式（' + S.detectedSpeakers.length + '位说话人）';
    label.style.color = 'var(--green)';
    renderSpeakerAssignmentList();
  } else if (S.detectedSpeakers.length === 1) {
    card.classList.add('visible');
    label.textContent = '单人模式（检测到1位说话人标记）';
    label.style.color = 'var(--orange)';
    renderSpeakerAssignmentList();
  } else {
    card.classList.remove('visible');
    label.textContent = '单人模式';
    label.style.color = 'var(--text2)';
  }

  // Update generate button validation state
  updateGenerateBtnState();
}

function renderSpeakerAssignmentList() {
  var container = E.speakerList;
  if (!container) return;

  var html = '';
  var speakers = S.detectedSpeakers;

  for (var i = 0; i < speakers.length; i++) {
    var sp = speakers[i];
    var color = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
    var assignedSource = S.speakerAssignments[sp.name] || '';

    html += '<div class="speaker-row">';
    html += '<span class="sp-color" style="background:' + color + '"></span>';
    html += '<span class="sp-name">' + escHtml(sp.name) + '</span>';
    html += '<span class="sp-stats">' + sp.charCount + '字 / ' + sp.lineCount + '行</span>';
    html += '<select class="sp-select" data-speaker="' + escHtml(sp.name) + '" onchange="assignSpeakerVoice(this)">';
    html += '<option value="">-- 选择音源 --</option>';

    // Add saved audio sources
    for (var j = 0; j < S.audioSources.length; j++) {
      var src = S.audioSources[j];
      var sel = assignedSource === src.id ? ' selected' : '';
      html += '<option value="' + escHtml(src.id) + '"' + sel + '>' + escHtml(src.name) + '</option>';
    }

    // Add "upload new" option
    html += '<option value="__upload__">上传新音源...</option>';
    html += '</select>';

    // Show assigned voice info
    if (S.speakerVoiceData[sp.name]) {
      html += '<span class="sp-preview">&#x2705; ' + escHtml(S.speakerVoiceData[sp.name].audioFile?.name || '已分配') + '</span>';
    }

    // Upload button for direct upload
    html += '<div class="sp-upload">';
    html += '<button class="sp-upload-btn" onclick="uploadSpeakerVoice(\\'' + escHtml(sp.name) + '\\')">&#x1F4E4; 上传音源</button>';
    html += '<input type="file" accept="audio/*" style="display:none" id="spUpload_' + i + '" onchange="handleSpeakerVoiceUpload(event, \\'' + escHtml(sp.name) + '\\')">';
    html += '</div>';

    html += '</div>';
  }

  container.innerHTML = html;
}

function assignSpeakerVoice(selectEl) {
  var speakerName = selectEl.getAttribute('data-speaker');
  var value = selectEl.value;

  if (value === '__upload__') {
    // Trigger file upload for this speaker
    var idx = S.detectedSpeakers.findIndex(function(s) { return s.name === speakerName; });
    var fileInput = document.getElementById('spUpload_' + idx);
    if (fileInput) fileInput.click();
    selectEl.value = S.speakerAssignments[speakerName] || '';
    return;
  }

  if (value) {
    S.speakerAssignments[speakerName] = value;
    // Load the audio source data for this speaker
    var src = S.audioSources.find(function(s) { return s.id === value; });
    if (src) {
      S.speakerVoiceData[speakerName] = {
        audioFile: { name: src.name + '.wav', dataUrl: src.dataUrl, base64: src.dataUrl.split(',')[1] },
        nvReferenceId: src.nvReferenceId || null
      };
    }
  } else {
    delete S.speakerAssignments[speakerName];
    delete S.speakerVoiceData[speakerName];
  }

  updateGenerateBtnState();
}

function uploadSpeakerVoice(speakerName) {
  var idx = S.detectedSpeakers.findIndex(function(s) { return s.name === speakerName; });
  var fileInput = document.getElementById('spUpload_' + idx);
  if (fileInput) fileInput.click();
}

async function handleSpeakerVoiceUpload(event, speakerName) {
  var file = event.target.files[0];
  if (!file) return;

  showToast('正在加载 ' + speakerName + ' 的音源...', 'info');

  var dataUrl = await new Promise(function(resolve) {
    var reader = new FileReader();
    reader.onload = function(e) { resolve(e.target.result); };
    reader.readAsDataURL(file);
  });

  var base64 = dataUrl.split(',')[1];

  // Optimize the audio (trim to 10s, resample to 24kHz)
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    var resp = await fetch(dataUrl);
    var arrayBuffer = await resp.arrayBuffer();
    var decoded = await ctx.decodeAudioData(arrayBuffer);
    var duration = Math.min(decoded.duration, 10);
    var trimSamples = Math.floor(duration * 24000);
    var channelData = decoded.getChannelData(0);
    if (trimSamples < channelData.length) channelData = channelData.slice(0, trimSamples);
    var trimBuffer = ctx.createBuffer(1, channelData.length, 24000);
    trimBuffer.copyToChannel(channelData, 0);
    var wavBlob = audioBufferToWav(trimBuffer);
    ctx.close();

    var optDataUrl = await new Promise(function(resolve) {
      var reader2 = new FileReader();
      reader2.onload = function(e) { resolve(e.target.result); };
      reader2.readAsDataURL(wavBlob);
    });

    S.speakerVoiceData[speakerName] = {
      audioFile: { name: file.name, dataUrl: optDataUrl, base64: optDataUrl.split(',')[1], wavBlob: wavBlob },
      nvReferenceId: null
    };
  } catch(e) {
    S.speakerVoiceData[speakerName] = {
      audioFile: { name: file.name, dataUrl: dataUrl, base64: base64 },
      nvReferenceId: null
    };
  }

  // Also offer to save as a named source
  var saveName = speakerName + '音色';
  var existing = S.audioSources.find(function(s) { return s.name === saveName; });
  if (!existing) {
    S.audioSources.push({
      id: hexId(),
      name: saveName,
      dataUrl: S.speakerVoiceData[speakerName].audioFile.dataUrl,
      nvReferenceId: null,
      addedAt: Date.now()
    });
    saveAudioSources();
    renderSourceList();
    renderSourceSelect();
  }

  showToast(speakerName + ' 的音源已加载', 'success');
  renderSpeakerAssignmentList();
  updateGenerateBtnState();
  event.target.value = '';
}

function updateGenerateBtnState() {
  var btn = E.generateBtn;
  if (S.speakerMode === 'multi') {
    // Check if all speakers have voices assigned
    var allAssigned = true;
    for (var i = 0; i < S.detectedSpeakers.length; i++) {
      var sp = S.detectedSpeakers[i];
      if (!S.speakerVoiceData[sp.name] && !S.speakerAssignments[sp.name]) {
        allAssigned = false;
        break;
      }
    }
    if (!allAssigned) {
      btn.style.opacity = '0.6';
      btn.title = '请为所有说话人分配音源';
    } else {
      btn.style.opacity = '1';
      btn.title = '';
    }
  } else {
    btn.style.opacity = '1';
    btn.title = '';
  }
}

// ==================== Speaker-Aware Text Splitting ====================
function splitTextBySpeakers(text, maxChars) {
  // Returns array of { speaker, segments: [{text, lines, segIndex}] }
  if (!text || !text.trim()) return [];

  var patterns = getSpeakerPatterns();
  var lines = text.split('\\n');
  var currentSpeaker = null;
  var speakerBlocks = []; // { speaker, lines: [{text, isContinuation}] }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var matched = false;

    for (var pi = 0; pi < patterns.length; pi++) {
      var match = line.match(patterns[pi].regex);
      if (match && match[1]) {
        var name = match[1].trim();
        if (name && name.length <= 8) {
          currentSpeaker = name;
          var content = line.replace(patterns[pi].regex, '').trim();
          if (content) {
            speakerBlocks.push({ speaker: name, text: content });
          }
          matched = true;
          break;
        }
      }
    }

    if (!matched && line.trim()) {
      // Continuation of previous speaker
      if (currentSpeaker) {
        speakerBlocks.push({ speaker: currentSpeaker, text: line.trim() });
      } else {
        // No speaker context yet, treat as default
        speakerBlocks.push({ speaker: null, text: line.trim() });
      }
    }
  }

  // Group consecutive blocks of the same speaker and split by maxChars
  var result = [];
  var currentGroup = null;

  for (var bi = 0; bi < speakerBlocks.length; bi++) {
    var block = speakerBlocks[bi];
    if (!currentGroup || currentGroup.speaker !== block.speaker) {
      if (currentGroup) result.push(currentGroup);
      currentGroup = { speaker: block.speaker, rawText: block.text, lines: [block.text] };
    } else {
      currentGroup.rawText += '\\n' + block.text;
      currentGroup.lines.push(block.text);
    }
  }
  if (currentGroup) result.push(currentGroup);

  // Now split each group's text into TTS segments
  for (var gi = 0; gi < result.length; gi++) {
    var group = result[gi];
    var segs = splitTextForTTS(group.rawText, maxChars);
    group.segments = segs;
    // Tag each segment with the speaker
    for (var si = 0; si < segs.length; si++) {
      segs[si].speaker = group.speaker;
    }
  }

  return result;
}

// Speaker pattern management
function addSpeakerPattern() {
  var input = document.getElementById('newSpeakerPattern');
  var pattern = input.value.trim();
  if (!pattern) { showToast('请输入正则表达式', 'error'); return; }
  try {
    new RegExp(pattern); // validate
  } catch(e) {
    showToast('正则表达式无效: ' + e.message, 'error');
    return;
  }
  if (!S.config.spCustomPatterns) S.config.spCustomPatterns = [];
  S.config.spCustomPatterns.push(pattern);
  saveConfig();
  renderSpeakerPatterns();
  input.value = '';
  showToast('已添加自定义说话人模式', 'success');
}

function removeSpeakerPattern(idx) {
  if (S.config.spCustomPatterns) {
    S.config.spCustomPatterns.splice(idx, 1);
    saveConfig();
    renderSpeakerPatterns();
  }
}

function renderSpeakerPatterns() {
  var container = E.speakerPatternsList;
  if (!container) return;
  var patterns = S.config.spCustomPatterns || [];
  if (patterns.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text2);padding:4px">暂无自定义模式</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < patterns.length; i++) {
    html += '<div class="speaker-pattern-row">';
    html += '<input type="text" value="' + escHtml(patterns[i]) + '" readonly>';
    html += '<button class="sp-del" onclick="removeSpeakerPattern(' + i + ')">&#x2716;</button>';
    html += '</div>';
  }
  container.innerHTML = html;
}

function splitTextForTTS(text, maxChars) {
  if (!text || !text.trim()) return [];
  if (!maxChars) maxChars = S.engine === 'nicevoice' ? 150 : S.engine === 'kikivoice' ? kkMaxChars() : 250;

  var originalLines = text.split('\\n');

  // Build merged text and track line positions
  var merged = '';
  var lineInfos = [];
  for (var i = 0; i < originalLines.length; i++) {
    var lineText = originalLines[i];
    if (i > 0) merged += ' ';
    var startPos = merged.length;
    merged += lineText;
    lineInfos.push({ text: lineText, startPos: startPos, endPos: merged.length });
  }

  // Step 1: Split into sentences at punctuation boundaries
  var sentenceEndRe = /[。！？.!?…]/g;
  var breakPoints = [];
  var match;
  while ((match = sentenceEndRe.exec(merged)) !== null) {
    breakPoints.push(match.index + 1);
  }
  breakPoints.push(merged.length);

  var sentences = [];
  var sStart = 0;
  for (var b = 0; b < breakPoints.length; b++) {
    var bp = breakPoints[b];
    var sText = merged.substring(sStart, bp).trim();
    if (sText) {
      sentences.push({ text: sText, start: sStart, end: bp });
    }
    sStart = bp;
  }

  // Step 2: Merge sentences into segments up to maxChars
  var segments = [];
  var currentText = '';
  var currentStart = 0;

  for (var si = 0; si < sentences.length; si++) {
    var sent = sentences[si];
    var combinedLen = currentText.length + (currentText ? 1 : 0) + sent.text.length;

    if (currentText && combinedLen > maxChars) {
      // Current segment is full, push it
      var lines = getLinesInRange(currentStart, currentStart + currentText.length, lineInfos);
      segments.push({ text: currentText, lines: lines, segIndex: segments.length });
      currentText = sent.text;
      currentStart = sent.start;
    } else {
      // Add sentence to current segment
      currentText = currentText ? currentText + ' ' + sent.text : sent.text;
      if (!currentStart) currentStart = sent.start;
    }
  }

  // Push remaining
  if (currentText.trim()) {
    var lines = getLinesInRange(currentStart, currentStart + currentText.length, lineInfos);
    segments.push({ text: currentText.trim(), lines: lines, segIndex: segments.length });
  }

  // Step 3: Handle any segments that still exceed maxChars (very long sentences with no punctuation)
  var finalSegments = [];
  for (var fi = 0; fi < segments.length; fi++) {
    if (segments[fi].text.length > maxChars) {
      var subSegs = splitLongSegment(segments[fi].text, maxChars, 0, [{ text: segments[fi].text, startPos: 0, endPos: segments[fi].text.length }]);
      for (var ss = 0; ss < subSegs.length; ss++) finalSegments.push(subSegs[ss]);
    } else {
      finalSegments.push(segments[fi]);
    }
  }

  for (var fi = 0; fi < finalSegments.length; fi++) finalSegments[fi].segIndex = fi;

  return finalSegments;
}

function splitLongSegment(text, maxChars, globalStart, lineInfos) {
  var result = [];
  var parts = text.split(/[,，;；、]/);
  var current = '';
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (current.length + part.length + 1 > maxChars && current) {
      var cl = getLinesInRange(globalStart, globalStart + current.length, lineInfos);
      result.push({ text: current.trim(), lines: cl, segIndex: result.length });
      globalStart += current.length;
      current = part;
    } else {
      if (current) current += ',' + part;
      else current = part;
    }
  }
  if (current.trim()) {
    var cl = getLinesInRange(globalStart, globalStart + current.length, lineInfos);
    result.push({ text: current.trim(), lines: cl, segIndex: result.length });
  }
  return result;
}

function getLinesInRange(startPos, endPos, lineInfos) {
  var result = [];
  for (var i = 0; i < lineInfos.length; i++) {
    if (lineInfos[i].endPos > startPos && lineInfos[i].startPos < endPos) {
      result.push({ text: lineInfos[i].text, lineIndex: i });
    }
  }
  return result;
}

// ==================== NiceVoice TTS Generation ====================
async function nvCloneVoice() {
  if (!S.audioFile || !S.audioFile.base64) {
    showToast('请先上传参考音频', 'error');
    return null;
  }

  var cloneStatus = E.cloneStatus;

  // ===== Check if we already have a referenceId from a saved source =====
  if (S.nvReferenceId) {
    cloneStatus.style.display = 'block';
    cloneStatus.textContent = '正在验证已保存的音色...';

    try {
      var verifyResp = await fetch('/api/nv/getSyncRefStatus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId: S.nvReferenceId })
      });
      var verifyData = await verifyResp.json();

      if (verifyData.data && verifyData.data.error === 0) {
        // Reference still valid on server — reuse it!
        cloneStatus.textContent = '音色验证通过，无需重新克隆';
        showToast('音色已在服务器端，直接复用', 'success');
        return S.nvReferenceId;
      } else {
        // Reference expired/invalid on server — need to re-clone
        cloneStatus.textContent = '服务器端音色已失效，需要重新克隆...';
        showToast('音色已失效，正在重新克隆...', 'info');
        S.nvReferenceId = null; // Clear invalid reference
        // Fall through to full clone flow below
      }
    } catch(verifyErr) {
      cloneStatus.textContent = '验证请求失败，将重新克隆...';
      S.nvReferenceId = null;
      // Fall through to full clone flow below
    }
  }

  // ===== Full clone flow =====
  cloneStatus.style.display = 'block';
  cloneStatus.textContent = '正在上传参考音频...';
  S.nvCloneBusy = true;

  try {
    // Calculate audio file size and duration
    var audioBlob = S.audioFile.wavBlob;
    var fileSize = audioBlob ? audioBlob.size : 0;
    var audioDuration = 10; // default, will be refined
    if (audioBlob) {
      try {
        var tempCtx = new (window.AudioContext || window.webkitAudioContext)();
        var tempBuf = await tempCtx.decodeAudioData(await audioBlob.arrayBuffer());
        audioDuration = tempBuf.duration;
        tempCtx.close();
      } catch(e) {
      }
    }

    // Step 1: Get upload URL
    var resp1 = await fetch('/api/nv/getUploadUrl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suffix: '.wav', fileSize: fileSize, audioDuration: audioDuration })
    });
    var data1 = await resp1.json();
    appLog('[NV] getUploadUrl => ' + JSON.stringify(data1).substring(0, 500), 'i');
    if (!data1.data || (!data1.data.url && !data1.data.uploadUrl)) {
      throw new Error('获取上传地址失败: ' + JSON.stringify(data1));
    }
    var uploadUrl = data1.data.uploadUrl || data1.data.url;
    var referenceId = data1.data.referenceId || data1.data.refId;
    var filePath = data1.data.filePath || '';

    cloneStatus.textContent = '正在上传音频文件...';

    // Step 2: Upload audio to presigned URL via proxy
    var resp2 = await fetch('/api/nv-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadUrl: uploadUrl, audioBase64: S.audioFile.base64 })
    });
    var data2 = await resp2.json();
    appLog('[NV] 上传结果 => ' + JSON.stringify(data2), 'i');
    if (!data2.ok) {
      throw new Error('上传音频失败: ' + data2.status);
    }

    cloneStatus.textContent = '正在训练声音模型...';

    // Step 3: Save reference audio (trigger clone training)
    var resp3 = await fetch('/api/nv/saveRefAudio2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioPath: filePath,
        referenceId: referenceId,
        referenceName: S.audioFile.name || 'ref_audio',
        text: '',
        fileSize: fileSize,
        audioDuration: audioDuration
      })
    });
    var data3 = await resp3.json();
    appLog('[NV] saveRefAudio2 => ' + JSON.stringify(data3).substring(0, 500), 'i');
    if (!data3.data || !data3.data.referenceId) {
      throw new Error('创建声音克隆失败: ' + JSON.stringify(data3));
    }
    referenceId = data3.data.referenceId;

    // Step 4: Poll clone status
    var maxPoll = S.config.nvMaxPoll || 60;
    for (var i = 0; i < maxPoll; i++) {
 if (S.cancelRequested) { S.nvCloneBusy = false; return null; }
      await sleep(2000);
      cloneStatus.textContent = '训练声音模型中... (' + (i + 1) + '/' + maxPoll + ')';

      var resp4 = await fetch('/api/nv/getSyncRefStatus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceId: referenceId })
      });
      var data4 = await resp4.json();
      if (i % 5 === 0 || (data4.data && data4.data.error === 0)) {
        appLog('[NV] getSyncRefStatus[' + (i+1) + '] => ' + JSON.stringify(data4).substring(0, 300), 'i');
      }
      if (data4.data && data4.data.error === 0) {
        S.nvReferenceId = referenceId;
        cloneStatus.textContent = '声音模型训练完成！';
        S.nvCloneBusy = false;
        showToast('声音克隆完成', 'success');
        appLog('[NV] 声音克隆完成', 's');

        // ===== Auto-save referenceId to active audio source =====
        nvSaveReferenceToActiveSource(referenceId);

        return referenceId;
      }
    }
    throw new Error('声音克隆超时');
  } catch(e) {
    cloneStatus.textContent = '克隆失败: ' + e.message;
    S.nvCloneBusy = false;
    showToast('声音克隆失败: ' + e.message, 'error');
    return null;
  }
}

// Save referenceId back to the currently active audio source in localStorage
function nvSaveReferenceToActiveSource(referenceId) {
  if (!referenceId || !S.activeSourceId) {
    return;
  }
  var src = S.audioSources.find(function(s) { return s.id === S.activeSourceId; });
  if (src) {
    src.nvReferenceId = referenceId;
    saveAudioSources();
  }
}

async function nvGenerateSegment(text, referenceId, segIdx) {
  var maxPoll = S.config.nvMaxPoll || 60;
  var retries = 0;
  var maxRetries = 3;

  while (retries <= maxRetries) {
    if (S.cancelRequested) {
      return null;
    }
    try {
      // Submit TTS request (NiceVoice only needs text + referenceId)
      var resp1 = await fetch('/api/nv/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          referenceId: referenceId
        })
      });
      var data1 = await resp1.json();
      appLog('[NV] tts => ' + JSON.stringify(data1).substring(0, 500), 'i');
      // Handle rate limit by waiting and retrying
      if (data1.code === 70002006 || (data1.msg && data1.msg.toastZh && data1.msg.toastZh.indexOf('频繁') >= 0)) {
        if (retries < maxRetries) {
          retries++;
          await sleep(16000); // Wait 16s for rate limit
          continue;
        }
        throw new Error('请求过于频繁，请稍后重试');
      }
      if (!data1.data || !data1.data.taskSn) {
        throw new Error('TTS提交失败: ' + JSON.stringify(data1));
      }
      var taskSn = data1.data.taskSn;

      // Poll for result
      for (var p = 0; p < maxPoll; p++) {
        if (S.cancelRequested) {
          return null;
        }
        await sleep(2000);
        var resp2 = await fetch('/api/nv/getItemByTaskSn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskSn: taskSn })
        });
        var data2 = await resp2.json();
        if (p % 5 === 0 || (data2.data && data2.data.statusStr === 'success')) {
          appLog('[NV] getItemByTaskSn[' + (p+1) + '] => ' + JSON.stringify(data2).substring(0, 300), 'i');
        }
        if (data2.data && data2.data.statusStr === 'success' && data2.data.audioUrl) {
          // Download audio via proxy
          var audioUrl = data2.data.audioUrl;
          var audioResp = await fetch('/api/audio-proxy?url=' + encodeURIComponent(audioUrl));
          if (!audioResp.ok) throw new Error('下载音频失败');
          var audioArrayBuffer = await audioResp.arrayBuffer();
          return new Blob([audioArrayBuffer], { type: 'audio/mpeg' });
        }
        if (data2.data && data2.data.statusStr === 'failed') {
          throw new Error('TTS生成失败');
        }
      }
      throw new Error('TTS轮询超时');
    } catch(e) {
      retries++;
      if (retries > maxRetries) throw e;
      await sleep(2000 * retries);
    }
  }
}

async function nvGenerateAll(segments, referenceId) {
  var waitMs = (S.config.nvWait || 16) * 1000;
  var bufIdx = 0;

  for (var i = 0; i < segments.length; i++) {
    if (S.cancelRequested) {
      break;
    }

    var seg = S.segments[i];
    seg.status = 'submitting';
    renderSegmentTable();

    if (i > 0) {
      // Wait between requests for rate limiting
      seg.status = 'processing';
      renderSegmentTable();
      showToast('等待 ' + (waitMs / 1000) + '秒后继续...', 'info');
      var waitStart = Date.now();
      while (Date.now() - waitStart < waitMs && !S.cancelRequested) {
        await sleep(500);
      }
      if (S.cancelRequested) {
        break;
      }
    }

    try {
      appLog('[NV] 生成段' + (i+1) + '/' + S.segments.length, 'i');
      var audioBlob = await nvGenerateSegment(seg.text, referenceId, i);
      if (!audioBlob) {
        seg.status = 'cancelled';
        renderSegmentTable();
        continue;
      }

      seg.audioBlob = audioBlob;
      // Get duration
      try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());
        seg.duration = audioBuffer.duration;
        audioCtx.close();
      } catch(de) {
        seg.duration = audioBlob.size / (24000 * 2);
      }

      seg.status = 'done';
      bufIdx++;
      appLog('[NV] 段' + (i+1) + ' OK', 's');
    } catch(e) {
      seg.status = 'error';
      seg.error = e.message;
    }
    renderSegmentTable();
    updateProgress();
  }
}

// ==================== IndexTTS Generation ====================
async function idxGenerateAll(segments) {
  var retryCount = S.config.retryCount;
  var pollInterval = S.config.pollInterval;
  var apiBase = S.config.apiBase;
  var language = S.config.language;
  var speakerWav = S.audioFile.base64;
  var concurrency = S.config.concurrency;

  var indices = [];
  for (var i = 0; i < S.segments.length; i++) indices.push(i);

  var nextIdx = 0;
  var active = new Map();

  function launchNext() {
    while (nextIdx < indices.length && active.size < concurrency && !S.cancelRequested) {
      var segIdx = indices[nextIdx++];
      var p = idxProcessSegment(segIdx, apiBase, language, speakerWav, retryCount, pollInterval);
      var entry = { promise: p, segIdx: segIdx };
      p.then(function() { active.delete(entry); }, function() { active.delete(entry); });
      active.set(entry, entry);
    }
  }

  launchNext();
  while (active.size > 0) {
    if (S.cancelRequested) {
      for (var i = 0; i < S.segments.length; i++) {
        if (S.segments[i].status === 'pending' || S.segments[i].status === 'submitting' || S.segments[i].status === 'processing') {
          S.segments[i].status = 'cancelled';
        }
      }
      renderSegmentTable();
      updateProgress();
      break;
    }
    var promises = [];
    active.forEach(function(entry) { promises.push(entry.promise); });
    await Promise.race(promises);
    launchNext();
  }
}

async function idxProcessSegment(segIdx, apiBase, language, speakerWav, retryCount, pollInterval) {
  var seg = S.segments[segIdx];
  seg.status = 'submitting';
  renderSegmentTable();

  for (var attempt = 0; attempt <= retryCount; attempt++) {
    if (S.cancelRequested) {
      seg.status = 'cancelled';
      renderSegmentTable();
      break;
    }
    try {
      var submitResp = await fetch(apiBase + '/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: seg.text, speaker_wav: speakerWav, language: language })
      });
      if (!submitResp.ok) {
        throw new Error('Submit failed: ' + submitResp.status);
      }
      var submitData = await submitResp.json();
      appLog('[IDX] generate => ' + JSON.stringify(submitData).substring(0, 300), 'i');
      if (!submitData.job_id) {
        throw new Error('No job_id returned');
      }

      seg.jobId = submitData.job_id;
      seg.status = 'processing';
      renderSegmentTable();

      for (var poll = 0; poll < 300; poll++) {
        if (S.cancelRequested) {
          seg.status = 'cancelled';
          renderSegmentTable();
          return;
        }
        await sleep(pollInterval);
        var statusResp = await fetch(apiBase + '/status/' + seg.jobId);
        if (!statusResp.ok) {
 continue;
        }
        var statusData = await statusResp.json();
        if (poll % 5 === 0 || statusData.status === 'completed') {
          appLog('[IDX] status[' + (poll+1) + '] => ' + JSON.stringify(statusData).substring(0, 200), 'i');
        }

        if (statusData.status === 'completed') {
          var resultResp = await fetch(apiBase + '/result/' + seg.jobId);
          if (!resultResp.ok) throw new Error('Failed to get audio');
          var audioArrayBuffer = await resultResp.arrayBuffer();
          seg.audioBlob = new Blob([audioArrayBuffer], { type: 'audio/wav' });
          try {
            var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            var audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));
            seg.duration = audioBuffer.duration;
            audioCtx.close();
          } catch(de) {
            seg.duration = audioArrayBuffer.byteLength / (44100 * 2);
          }
          seg.status = 'done';
          renderSegmentTable();
          updateProgress();
          return;
        } else if (statusData.status === 'error') {
          throw new Error('API error');
        }
      }
      throw new Error('Polling timeout');
    } catch(e) {
      if (attempt < retryCount && !S.cancelRequested) {
        seg.status = 'submitting';
        renderSegmentTable();
        await sleep(1000 * (attempt + 1));
        continue;
      }
      seg.status = 'error';
      seg.error = e.message;
      renderSegmentTable();
      updateProgress();
      return;
    }
  }
}


// ==================== Log Console ====================
function appLog(msg, type) {
  type = type || 'i';
  var c = document.getElementById('logBox');
  if (!c) return;
  var e = document.createElement('div');
  e.className = 'log-entry ' + type;
  e.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
}

// ==================== KikiVoice Functions ====================
var KK_MAX_RETRIES = 3;
var KK_MODEL_IDS = {'kiki_core':'mCore','kiki_pro':'mPro','kiki_multilingual':'mMulti'};

function kkMaxChars() {
  if (S.kkCaps && S.kkCaps.model_capabilities && S.kkCaps.model_capabilities[S.kkModel])
    return S.kkCaps.model_capabilities[S.kkModel].max_text_length || 1000;
  if (S.kkModel === 'kiki_pro') return 500;
  if (S.kkModel === 'kiki_multilingual') return 2000;
  return 1000;
}

function pickKKModel(m) {
  S.kkModel = m;
  Object.entries(KK_MODEL_IDS).forEach(function(entry) {
    var el = document.getElementById(entry[1]);
    if (el) el.className = 'kk-model' + (entry[0] === m ? ' sel' : '');
  });
  var isPro = m === 'kiki_pro';
  var emotionRow = document.getElementById('emotionRow');
  var intensityRow = document.getElementById('intensityRow');
  if (emotionRow) emotionRow.className = 'kk-param-row' + (isPro ? ' kk-pro-only active' : ' kk-pro-only');
  if (intensityRow) intensityRow.className = 'kk-param-row' + (isPro ? ' kk-pro-only active' : ' kk-pro-only');
  updateTextStats();
}

function updKKParam() {
  var speedEl = document.getElementById('kSpeed');
  var volEl = document.getElementById('kVolume');
  var speedValEl = document.getElementById('kSpeedVal');
  var volValEl = document.getElementById('kVolumeVal');
  if (speedEl && speedValEl) speedValEl.textContent = parseFloat(speedEl.value).toFixed(1);
  if (volEl && volValEl) volValEl.textContent = volEl.value;
}

async function kGet(path) {
  var r = await fetch('/api/kiki' + path + (path.includes('?') ? '&' : '?') + 'uuid=' + encodeURIComponent(S.kkUuid));
  var d;
  try { d = await r.json(); } catch(e) { d = { error_code: -1, msg: 'Invalid JSON' }; }
  appLog('[KK] GET ' + path + ' => ' + r.status + ' | error_code=' + (d.error_code !== undefined ? d.error_code : '?'), d.error_code === 0 ? 'i' : 'e');
  if (d.msg) appLog('[KK] msg: ' + d.msg, d.error_code === 0 ? 'i' : 'w');
  // Always log full response data for debugging
  appLog('[KK] 完整响应: ' + JSON.stringify(d).substring(0, 500), 'i');
  return d;
}

async function kPost(path, body) {
  var r = await fetch('/api/kiki' + path + (path.includes('?') ? '&' : '?') + 'uuid=' + encodeURIComponent(S.kkUuid), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kiki-Uuid': S.kkUuid },
    body: JSON.stringify(body)
  });
  var d;
  try { d = await r.json(); } catch(e) { d = { error_code: -1, msg: 'Invalid JSON' }; }
  appLog('[KK] POST ' + path + ' => ' + r.status + ' | error_code=' + (d.error_code !== undefined ? d.error_code : '?'), d.error_code === 0 ? 'i' : 'e');
  if (d.msg) appLog('[KK] msg: ' + d.msg, d.error_code === 0 ? 'i' : 'w');
  // Always log full response data for debugging
  appLog('[KK] 完整响应: ' + JSON.stringify(d).substring(0, 500), 'i');
  if (d.available_count !== undefined || d.user_tts_available_count !== undefined) updKKQuota(d);
  return d;
}

async function testKK() {
  appLog('[KK] 检测连接...', 'i');
  var cs = document.getElementById('kkConn');
  if (cs) { cs.className = 'kk-conn-status pen'; cs.innerHTML = '<span class="kk-conn-dot"></span>检测中...'; }
  try {
    var d = await kGet('/model-capabilities');
    appLog('[KK] model-capabilities完整响应: ' + JSON.stringify(d).substring(0, 800), 'i');
    if (d.error_code === 0) {
      S.kkConnected = true; S.kkCaps = d;
      if (cs) { cs.className = 'kk-conn-status ok'; cs.innerHTML = '<span class="kk-conn-dot"></span>已连接'; }
      appLog('[KK] 连接成功！', 's');
      var c = d.model_capabilities || {};
      if (c.kiki_core) { var el = document.querySelector('#mCore .mc'); if (el) el.textContent = c.kiki_core.credit_rate + 'x'; }
      if (c.kiki_pro) { var el = document.querySelector('#mPro .mc'); if (el) el.textContent = c.kiki_pro.credit_rate + 'x'; }
      if (c.kiki_multilingual && c.kiki_multilingual.credit_rates && c.kiki_multilingual.credit_rates.v2) { var el = document.querySelector('#mMulti .mc'); if (el) el.textContent = c.kiki_multilingual.credit_rates.v2.rate + 'x'; }
      updateTextStats();
    } else {
      S.kkConnected = false;
      if (cs) { cs.className = 'kk-conn-status fail'; cs.innerHTML = '<span class="kk-conn-dot"></span>失败'; }
      appLog('[KK] 连接失败: ' + (d.msg || d.error_summary || JSON.stringify(d).substring(0, 300)), 'e');
    }
  } catch(e) {
    S.kkConnected = false;
    if (cs) { cs.className = 'kk-conn-status fail'; cs.innerHTML = '<span class="kk-conn-dot"></span>错误'; }
    appLog('[KK] 错误: ' + e.message, 'e');
  }
}

function updKKQuota(d) {
  if (!d) return;
  var a = d.available_count ?? d.available ?? d.user_tts_available_count;
  var u = d.used_count ?? d.used ?? d.user_tts_used_count;
  var m = d.max_count ?? d.max ?? S.kkQuota.m;
  var r = d.next_reset_days ?? d.resetTime;
  if (typeof a === 'number') S.kkQuota.a = a;
  if (typeof u === 'number') S.kkQuota.u = u;
  if (typeof m === 'number') S.kkQuota.m = m;
  if (typeof r === 'number') S.kkQuota.r = r;
  var qAvail = document.getElementById('qAvail');
  var qUsed = document.getElementById('qUsed');
  var qReset = document.getElementById('qReset');
  var qBar = document.getElementById('qBar');
  if (qAvail) qAvail.textContent = S.kkQuota.a.toLocaleString();
  if (qUsed) qUsed.textContent = S.kkQuota.u.toLocaleString();
  if (qReset) qReset.textContent = S.kkQuota.r + '天后重置';
  var p = S.kkQuota.m > 0 ? (S.kkQuota.a / S.kkQuota.m * 100) : 0;
  if (qBar) { qBar.style.width = p + '%'; qBar.className = 'kk-qb ' + (p >= 60 ? 'g' : p >= 30 ? 'y' : 'r'); }
  if (d.deducted_credits) appLog('[KK] 本次扣除: ' + d.deducted_credits, 'i');
}

// CF Verification
function showCFPanel(vpath, wip, rawResp) {
  appLog('[CF] 显示极验验证面板', 'i');
  appLog('[CF] Worker IP: ' + (wip || '未知'), 'i');
  appLog('[CF] 验证路径: ' + (vpath || '空'), 'i');
  appLog('[CF] 原始响应: ' + (rawResp || '{}'), 'w');
  if (!vpath) {
    appLog('[CF] 警告: validation_url_path为空，尝试使用默认路径', 'w');
    vpath = '/auth/geetest-validation';
  }
  S.cfProxyUrl = location.origin + '/api/kiki/geetest-page?uuid=' + encodeURIComponent(S.kkUuid) + '&path=' + encodeURIComponent(vpath);
  var cfIP = document.getElementById('cfIP');
  var cfUUID = document.getElementById('cfUUID');
  var cfUrl = document.getElementById('cfUrl');
  var cfRaw = document.getElementById('cfRaw');
  var cfPanel = document.getElementById('cfPanel');
  if (cfIP) cfIP.textContent = wip || '未知';
  if (cfUUID) cfUUID.textContent = S.kkUuid;
  if (cfUrl) cfUrl.textContent = S.cfProxyUrl;
  if (cfRaw) cfRaw.textContent = rawResp || '{}';
  if (cfPanel) cfPanel.style.display = 'block';
  var iframe = document.getElementById('cfIframe');
  var overlay = document.getElementById('cfIframeOverlay');
  if (overlay) overlay.style.display = 'flex';
  if (iframe) {
    iframe.onload = function() { if (overlay) overlay.style.display = 'none'; appLog('[CF] 验证页面已加载', 's'); };
    iframe.src = S.cfProxyUrl;
  }
  if (cfPanel) cfPanel.scrollIntoView({behavior: 'smooth', block: 'center'});
}
function hideCFPanel() {
  var cfPanel = document.getElementById('cfPanel');
  var cfIframe = document.getElementById('cfIframe');
  if (cfPanel) cfPanel.style.display = 'none';
  if (cfIframe) cfIframe.src = 'about:blank';
}
function openCFNewTab() { window.open(S.cfProxyUrl, '_blank'); appLog('[CF] 已在新标签页打开', 'i'); }
function waitForCFVerification() { return new Promise(function(resolve, reject) { S.cfResolve = resolve; S.cfReject = reject; }); }
function cfDone() {
  hideCFPanel();
  appLog('[CF] 用户确认验证完成，继续生成...', 's');
  if (S.cfResolve) { S.cfResolve(); S.cfResolve = null; S.cfReject = null; }
}
// Auto-detect geetest verification completion via postMessage from iframe
window.addEventListener('message', function(ev) {
  if (ev.data && ev.data.type === 'geetest-success') {
    appLog('[CF] 检测到极验验证成功（自动）', 's');
    cfDone();
  }
  if (ev.data && ev.data.type === 'geetest-error') {
    appLog('[CF] 极验验证失败', 'e');
  }
});
function cfCancel() {
  hideCFPanel();
  appLog('[CF] 用户取消验证', 'e');
  if (S.cfReject) { S.cfReject(new Error('用户取消CF验证')); S.cfReject = null; S.cfResolve = null; }
  S.cancelRequested = true;
}

// KikiVoice generation
async function kkGenerateAll(segments) {
  // Auto-detect connection if not already connected
  if (!S.kkConnected) {
    appLog('[KK] 未连接，自动检测连接...', 'w');
    await testKK();
    if (!S.kkConnected) throw new Error('KikiVoice连接失败，请检查网络');
  }
  var vn = (S.audioFile && S.audioFile.name) ? S.audioFile.name.replace(/\.[^.]+$/, '') : 'MyVoice';

  appLog('[KK] 1.上传声音...', 'i');
  if (!S.kkVoiceId) {
    var sd = await kGet('/get-sig');
    if (sd.error_code !== 0) throw new Error('签名失败:' + (sd.msg || sd.error_summary || JSON.stringify(sd).substring(0, 200)));
    appLog('[KK] 签名OK', 's');
    appLog('[KK] 上传音频文件...', 'i');
    var uploadBlob = S.audioFile.wavBlob || (S.audioFile.base64 ? (function() { var binary = atob(S.audioFile.base64); var bytes = new Uint8Array(binary.length); for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return new Blob([bytes], {type: 'audio/wav'}); })() : null);
    if (!uploadBlob) throw new Error('无音频数据');
    var uploadFile = new File([uploadBlob], (S.audioFile.name || 'audio.wav'), { type: uploadBlob.type || 'audio/wav' });
    var fd = new FormData();
    fd.append('voice-file', uploadFile);
    fd.append('sig', sd.sig);
    fd.append('create_url', sd.kiki_voice_microservices_api_create_voice_url);
    fd.append('voice_name', vn);
    var r = await fetch('/api/kiki/upload-voice?uuid=' + encodeURIComponent(S.kkUuid), { method: 'POST', body: fd });
    var d;
    try { d = await r.json(); } catch(e) { throw new Error('上传响应解析失败'); }
    appLog('[KK] 上传: errcode=' + d.errcode, d.errcode === 0 ? 's' : 'e');
    if (d.errcode !== 0) {
      var em = {'-1':'上传失败','-2':'参数错误','-3':'语音达上限','-4':'不支持的格式','-5':'页面过期'};
      throw new Error('上传[' + d.errcode + ']:' + (em[d.errcode] || d.errmsg || '未知'));
    }
    S.kkVoiceId = d.voice_id;
    appLog('[KK] 声音ID: ' + S.kkVoiceId, 's');
  } else {
    appLog('[KK] 使用已有声音: ' + S.kkVoiceId, 'i');
  }

  appLog('[KK] 2.检测语言...', 'i');
  var lr = await kPost('/detect-language', { text: segments.join(' ').substring(0, 200) });
  var lc = 'zh';
  if (lr.error_code === 0 && lr.detected_language) {
    lc = lr.detected_language.code;
    appLog('[KK] 语言: ' + lr.detected_language.name + '(' + lc + ')', 's');
  } else appLog('[KK] 默认中文', 'w');

  appLog('[KK] 3.分段生成(' + S.segments.length + '段)', 'i');
  for (var i = 0; i < S.segments.length; i++) {
    if (S.cancelRequested) break;
    var seg = S.segments[i];
    seg.status = 'submitting';
    renderSegmentTable();
    var blob = null;
    for (var retry = 0; retry <= KK_MAX_RETRIES; retry++) {
      if (S.cancelRequested) { seg.status = 'cancelled'; renderSegmentTable(); break; }
      try {
        appLog('[KK] 创建任务(尝试' + (retry+1) + ')...', 'i');
        var td = await kPost('/create-clone-task', {
          text: seg.text, voice_id: S.kkVoiceId, lang_code: lc, model_type: S.kkModel,
          emotion: S.kkModel === 'kiki_pro' ? (document.getElementById('kEmotion') ? document.getElementById('kEmotion').value : 'normal') : 'normal',
          intensity: S.kkModel === 'kiki_pro' ? (document.getElementById('kIntensity') ? document.getElementById('kIntensity').value : 'normal') : 'normal',
          gender: document.getElementById('kGender') ? parseInt(document.getElementById('kGender').value) : 0,
          speed: document.getElementById('kSpeed') ? parseFloat(document.getElementById('kSpeed').value) : 1.0,
          volume: document.getElementById('kVolume') ? parseInt(document.getElementById('kVolume').value) : 100,
          format: 'mp3', hq: document.getElementById('kHq') ? parseInt(document.getElementById('kHq').value) : 0,
          mver: S.kkModel === 'kiki_multilingual' ? 'v2' : 'default'
        });
        if (td.error_code !== 0 && td.error_code !== undefined) {
          if (td.error_code === 777) {
            appLog('[KK] 收到777 - 需要极验验证!', 'w');
            appLog('[KK] Worker IP: ' + (td.public_ip || '未知'), 'w');
            appLog('[KK] 验证路径: ' + (td.validation_url_path || '空'), 'w');
            appLog('[KK] auth_solution: ' + (td.auth_solution || 'GEETEST'), 'i');
            appLog('[KK] 完整777响应: ' + JSON.stringify(td), 'w');
            showCFPanel(td.validation_url_path || '', td.public_ip || '', JSON.stringify(td, null, 2));
            await waitForCFVerification();
            appLog('[KK] 验证完成，重试...', 'i');
            continue;
          }
          if (td.error_code === 'QUOTA_EXCEEDED' || td.error_code === 403) {
            if (td.quota_info) updKKQuota(td.quota_info);
            throw new Error('积分不足！剩余: ' + (td.available_count || 0));
          }
          if (td.error_code === 'IP_DISABLED') throw new Error('IP被禁用');
          throw new Error('任务失败[' + td.error_code + ']:' + (td.msg || td.error_summary || JSON.stringify(td).substring(0, 300)));
        }
        if (!td.success && td.error_code === undefined) throw new Error('任务失败: ' + JSON.stringify(td).substring(0, 300));
        var jid = td.job_id;
        if (!jid) throw new Error('无job_id');
        appLog('[KK] 任务: ' + jid, 's');
        if (td.quota_info) updKKQuota(td.quota_info);
        var hb = (td.heartbeat_interval_seconds || 3) * 1000;
        var est = td.estimated_time_seconds || 30;
        appLog('[KK] 预计' + est + 's', 'i');
        seg.status = 'processing';
        renderSegmentTable();
        var done = false;
        var maxPoll = Math.ceil(est / (hb / 1000)) + 30;
        for (var p = 0; p < maxPoll; p++) {
          if (S.cancelRequested) { seg.status = 'cancelled'; renderSegmentTable(); break; }
          await sleep(hb);
          var sd2 = await kGet('/job-status?job_id=' + jid);
          if (sd2.error_code !== 0) { appLog('[KK] 轮询错误:' + sd2.error_code, 'e'); continue; }
          var js = sd2.job_state;
          appLog('[KK] 轮询[' + (p+1) + ']: state=' + js, 'i');
          if (js === 1) {
            done = true;
            var au = sd2.audiourl;
            if (au) {
              appLog('[KK] 音频OK', 's');
              var ar = await fetch('/api/kiki-audio?url=' + encodeURIComponent(au) + '&uuid=' + encodeURIComponent(S.kkUuid));
              if (ar.ok) blob = await ar.blob(); else throw new Error('下载失败:' + ar.status);
            } else throw new Error('无音频URL');
            if (sd2.quota_info) updKKQuota(sd2.quota_info);
            else if (typeof sd2.user_tts_available_count === 'number') updKKQuota({available: sd2.user_tts_available_count, used: sd2.user_tts_used_count});
            break;
          }
          if (js === -1) throw new Error('任务失败: ' + (sd2.msg || sd2.error_summary || ''));
        }
        if (!done) throw new Error('任务超时');
        if (blob) break;
      } catch(e) {
        appLog('[KK] 尝试' + (retry+1) + '失败: ' + e.message, 'e');
        if (e.message.includes('积分') || e.message.includes('IP被禁') || e.message.includes('取消CF')) throw e;
        if (retry < KK_MAX_RETRIES) { appLog('5秒后重试...', 'w'); await sleep(5000); }
      }
    }
    if (blob) {
      seg.audioBlob = blob;
      try { var ac = new (window.AudioContext||window.webkitAudioContext)(); var ab = await ac.decodeAudioData(await blob.arrayBuffer()); seg.duration = ab.duration; ac.close(); } catch(de) { seg.duration = blob.size / (24000*2); }
      seg.status = 'done';
      appLog('[KK] 段' + (i+1) + ' OK (' + Math.round(blob.size/1024) + 'KB)', 's');
    } else {
      seg.status = S.cancelRequested ? 'cancelled' : 'error';
      if (!S.cancelRequested) seg.error = 'KikiVoice生成失败';
      appLog('[KK] 段' + (i+1) + ' 失败', 'e');
    }
    renderSegmentTable();
    updateProgress();
  }
}

// ==================== Main Generation Entry ====================
async function startGenerate() {
  var text = E.textInput.value.trim();
  if (!text) { showToast('请输入要合成的文本', 'error'); return; }

  // Multi-speaker validation
  if (S.speakerMode === 'multi') {
    for (var vi = 0; vi < S.detectedSpeakers.length; vi++) {
      var sp = S.detectedSpeakers[vi];
      if (!S.speakerVoiceData[sp.name]) {
        // Try to load from assignment
        if (S.speakerAssignments[sp.name]) {
          var src = S.audioSources.find(function(s) { return s.id === S.speakerAssignments[sp.name]; });
          if (src) {
            S.speakerVoiceData[sp.name] = {
              audioFile: { name: src.name + '.wav', dataUrl: src.dataUrl, base64: src.dataUrl.split(',')[1] },
              nvReferenceId: src.nvReferenceId || null
            };
          }
        }
        if (!S.speakerVoiceData[sp.name]) {
          showToast('请为说话人 "' + sp.name + '" 分配音源', 'error');
          return;
        }
      }
    }
  } else {
    // Single speaker mode - need the standard audio file
    if (!S.audioFile || !S.audioFile.base64) { showToast('请先上传参考音频', 'error'); return; }
  }

  S.isGenerating = true;
  S.cancelRequested = false;
  S.segments = [];
  S.segmentBuffers = [];
  S.segmentDurations = [];
  S.resultWavBlob = null;
  S.resultSrt = '';
  // Clean up previous Object URL
  if (S.resultWavUrl) { URL.revokeObjectURL(S.resultWavUrl); S.resultWavUrl = null; }
  S.downloadTimestamp = (function() {
    var now = new Date();
    return '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '-' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  })();
  // Set project name: use docx filename if available, otherwise timestamp
  S.projectName = S.docxFileName || S.downloadTimestamp;

  var maxChars = S.engine === 'nicevoice' ? (S.config.nvMaxChars || 150) : S.engine === 'kikivoice' ? kkMaxChars() : (S.config.maxChars || 250);

  // Build segments based on speaker mode
  if (S.speakerMode === 'multi') {
    var spGroups = splitTextBySpeakers(text, maxChars);
    // Flatten all segments from all groups, preserving speaker info
    var allSegs = [];
    for (var gi = 0; gi < spGroups.length; gi++) {
      for (var si = 0; si < spGroups[gi].segments.length; si++) {
        var seg = spGroups[gi].segments[si];
        seg.speaker = spGroups[gi].speaker;
        allSegs.push(seg);
      }
    }
    S.segments = allSegs.map(function(seg) {
      return { text: seg.text, lines: seg.lines, speaker: seg.speaker, status: 'pending', jobId: null, audioBlob: null, duration: 0, error: null };
    });
    if (S.segments.length === 0) { showToast('文本为空或无法分段', 'error'); S.isGenerating = false; return; }
    appLog('[GEN] 引擎=' + S.engine + ' maxChars=' + maxChars + ' 分段数=' + S.segments.length + ' 说话人数=' + S.detectedSpeakers.length, 'i');
  } else {
    var segments = splitTextForTTS(text, maxChars);
    if (segments.length === 0) { showToast('文本为空或无法分段', 'error'); S.isGenerating = false; return; }
    S.segments = segments.map(function(seg) {
      return { text: seg.text, lines: seg.lines, speaker: null, status: 'pending', jobId: null, audioBlob: null, duration: 0, error: null };
    });
    appLog('[GEN] 引擎=' + S.engine + ' maxChars=' + maxChars + ' 分段数=' + segments.length, 'i');
  }

  // Update UI
  E.generateBtn.disabled = true;
  E.genBtnText.innerHTML = '<span class="spinner"></span> 合成中...';
  E.cancelBtn.style.display = 'block';
  E.progressBar.classList.add('active');
  E.progressFill.style.width = '0%';
  E.resultSection.classList.remove('active');
  renderSegmentTable();
  var logBox = document.getElementById('logBox'); if (logBox) logBox.innerHTML = '';
  S.kkVoiceId = null;

  S.elapsedStart = Date.now();
  updateElapsed();
  S.elapsedTimer = setInterval(updateElapsed, 1000);
  E.elapsed.style.display = 'block';

  if (S.engine === 'nicevoice') {
    // NiceVoice flow
    if (S.speakerMode === 'multi') {
      await nvMultiSpeakerGenerate();
    } else {
      var referenceId = await nvCloneVoice();
      if (referenceId && !S.cancelRequested) {
        await nvGenerateAll(S.segments, referenceId);
      }
    }
  } else if (S.engine === 'kikivoice') {
    // KikiVoice flow
    if (S.speakerMode === 'multi') {
      await kkMultiSpeakerGenerate();
    } else {
      await kkGenerateAll(S.segments);
    }
  } else {
    // IndexTTS flow
    if (S.speakerMode === 'multi') {
      await idxMultiSpeakerGenerate();
    } else {
      await idxGenerateAll(S.segments);
    }
  }

  // Done
  clearInterval(S.elapsedTimer);
  S.isGenerating = false;
  E.generateBtn.disabled = false;
  var btnLabel = S.engine === 'nicevoice' ? '&#x1F680; 开始合成 (NiceVoice)' : S.engine === 'kikivoice' ? '&#x1F680; 开始合成 (KikiVoice)' : '&#x1F680; 开始合成 (IndexTTS)';
  E.genBtnText.innerHTML = btnLabel;
  E.cancelBtn.style.display = 'none';

  var successSegs = S.segments.filter(function(s) { return s.status === 'done'; });
  var failedSegs = S.segments.filter(function(s) { return s.status === 'error'; });

  if (successSegs.length === 0) {
    showToast('全部段生成失败' + (S.cancelRequested ? '（已取消）' : ''), 'error');
    return;
  }

  try { await concatenateAudio(); } catch(e) { showToast('音频拼接失败: ' + e.message, 'error'); return; }
  generateSrt();

  // Create Object URL for playback (also reused for download)
  S.resultWavUrl = URL.createObjectURL(S.resultWavBlob);
  E.resultAudio.src = S.resultWavUrl;
  E.resultSection.classList.add('active');

  addHistory({
    text: text.substring(0, 200),
    engine: S.engine,
    segments: S.segments.length,
    success: successSegs.length,
    failed: failedSegs.length,
    date: new Date().toLocaleString('zh-CN'),
    timestamp: Date.now(),
    projectName: S.projectName
  });

  if (failedSegs.length > 0) {
    showToast('部分段生成失败 (' + failedSegs.length + '/' + S.segments.length + ')，已生成可用部分', 'error');
  } else {
    showToast('合成完成！共 ' + successSegs.length + ' 段' + (S.speakerMode === 'multi' ? '（' + S.detectedSpeakers.length + '位说话人）' : ''), 'success');
  }
}

// ==================== Multi-Speaker Generation Flows ====================
async function nvMultiSpeakerGenerate() {
  // Clone voices for each speaker first
  var speakerRefIds = {};
  for (var si = 0; si < S.detectedSpeakers.length; si++) {
    var sp = S.detectedSpeakers[si];
    var voiceData = S.speakerVoiceData[sp.name];
    if (!voiceData) { appLog('[NV] 说话人 ' + sp.name + ' 未分配音源', 'e'); continue; }

    // Temporarily set S.audioFile to this speaker's voice
    var prevAudio = S.audioFile;
    var prevRefId = S.nvReferenceId;
    S.audioFile = voiceData.audioFile;
    S.nvReferenceId = voiceData.nvReferenceId || null;

    appLog('[NV] 克隆说话人: ' + sp.name, 'i');
    var refId = await nvCloneVoice();
    speakerRefIds[sp.name] = refId;

    // Save back the reference ID
    voiceData.nvReferenceId = refId;
    // Also update the saved source if any
    if (S.speakerAssignments[sp.name]) {
      var src = S.audioSources.find(function(s) { return s.id === S.speakerAssignments[sp.name]; });
      if (src) { src.nvReferenceId = refId; saveAudioSources(); }
    }

    // Restore
    S.audioFile = prevAudio;
    S.nvReferenceId = prevRefId;

    if (S.cancelRequested) return;
  }

  // Generate segments using the appropriate reference ID
  var waitMs = (S.config.nvWait || 16) * 1000;
  for (var i = 0; i < S.segments.length; i++) {
    if (S.cancelRequested) break;

    var seg = S.segments[i];
    var refId = speakerRefIds[seg.speaker];
    if (!refId) {
      seg.status = 'error';
      seg.error = '说话人 ' + seg.speaker + ' 克隆失败';
      renderSegmentTable();
      updateProgress();
      continue;
    }

    seg.status = 'submitting';
    renderSegmentTable();

    if (i > 0) {
      seg.status = 'processing';
      renderSegmentTable();
      showToast('等待 ' + (waitMs / 1000) + '秒后继续...', 'info');
      var waitStart = Date.now();
      while (Date.now() - waitStart < waitMs && !S.cancelRequested) {
        await sleep(500);
      }
      if (S.cancelRequested) break;
    }

    try {
      appLog('[NV] 生成段' + (i+1) + '/' + S.segments.length + ' (说话人: ' + (seg.speaker || '默认') + ')', 'i');
      var audioBlob = await nvGenerateSegment(seg.text, refId, i);
      if (!audioBlob) {
        seg.status = 'cancelled';
        renderSegmentTable();
        continue;
      }

      seg.audioBlob = audioBlob;
      try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());
        seg.duration = audioBuffer.duration;
        audioCtx.close();
      } catch(de) {
        seg.duration = audioBlob.size / (24000 * 2);
      }
      seg.status = 'done';
      appLog('[NV] 段' + (i+1) + ' OK (' + (seg.speaker || '默认') + ')', 's');
    } catch(e) {
      seg.status = 'error';
      seg.error = e.message;
    }
    renderSegmentTable();
    updateProgress();
  }
}

async function kkMultiSpeakerGenerate() {
  // Generate segments using the appropriate voice for each speaker
  var kkVoiceIds = {};

  // Upload voices for each speaker
  for (var si = 0; si < S.detectedSpeakers.length; si++) {
    var sp = S.detectedSpeakers[si];
    var voiceData = S.speakerVoiceData[sp.name];
    if (!voiceData) { appLog('[KK] 说话人 ' + sp.name + ' 未分配音源', 'e'); continue; }

    appLog('[KK] 上传说话人音源: ' + sp.name, 'i');
    var voiceId = await kkUploadVoice(voiceData.audioFile, sp.name);
    kkVoiceIds[sp.name] = voiceId;
    if (S.cancelRequested) return;
  }

  // Generate segments
  for (var i = 0; i < S.segments.length; i++) {
    if (S.cancelRequested) break;
    var seg = S.segments[i];
    var voiceId = kkVoiceIds[seg.speaker];
    if (!voiceId) {
      seg.status = 'error';
      seg.error = '说话人 ' + seg.speaker + ' 音源上传失败';
      renderSegmentTable();
      updateProgress();
      continue;
    }
    await kkGenerateSegmentWithVoice(seg, voiceId, i);
  }
}

async function idxMultiSpeakerGenerate() {
  // For IndexTTS, generate segments with appropriate speaker_wav
  for (var i = 0; i < S.segments.length; i++) {
    if (S.cancelRequested) break;
    var seg = S.segments[i];
    var voiceData = S.speakerVoiceData[seg.speaker];
    var speakerWav = voiceData ? voiceData.audioFile.base64 : (S.audioFile ? S.audioFile.base64 : null);
    if (!speakerWav) {
      seg.status = 'error';
      seg.error = '说话人 ' + seg.speaker + ' 未分配音源';
      renderSegmentTable();
      updateProgress();
      continue;
    }
    await idxProcessSegmentWithWav(i, speakerWav);
  }
}

async function idxProcessSegmentWithWav(segIdx, speakerWav) {
  var seg = S.segments[segIdx];
  seg.status = 'submitting';
  renderSegmentTable();

  var retryCount = S.config.retryCount;
  var pollInterval = S.config.pollInterval;
  var apiBase = S.config.apiBase;
  var language = S.config.language;

  for (var attempt = 0; attempt <= retryCount; attempt++) {
    if (S.cancelRequested) {
      seg.status = 'cancelled';
      renderSegmentTable();
      return;
    }
    try {
      var submitResp = await fetch(apiBase + '/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: seg.text, speaker_wav: speakerWav, language: language })
      });
      if (!submitResp.ok) throw new Error('Submit failed: ' + submitResp.status);
      var submitData = await submitResp.json();
      if (!submitData.job_id) throw new Error('No job_id returned');

      seg.jobId = submitData.job_id;
      seg.status = 'processing';
      renderSegmentTable();

      for (var poll = 0; poll < 300; poll++) {
        if (S.cancelRequested) { seg.status = 'cancelled'; renderSegmentTable(); return; }
        await sleep(pollInterval);
        var statusResp = await fetch(apiBase + '/status/' + seg.jobId);
        if (!statusResp.ok) continue;
        var statusData = await statusResp.json();
        if (statusData.status === 'completed') {
          var resultResp = await fetch(apiBase + '/result/' + seg.jobId);
          if (!resultResp.ok) throw new Error('Failed to get audio');
          var audioArrayBuffer = await resultResp.arrayBuffer();
          seg.audioBlob = new Blob([audioArrayBuffer], { type: 'audio/wav' });
          try {
            var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            var audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));
            seg.duration = audioBuffer.duration;
            audioCtx.close();
          } catch(de) { seg.duration = audioArrayBuffer.byteLength / (44100 * 2); }
          seg.status = 'done';
          renderSegmentTable();
          updateProgress();
          return;
        } else if (statusData.status === 'error') { throw new Error('API error'); }
      }
      throw new Error('Polling timeout');
    } catch(e) {
      if (attempt < retryCount && !S.cancelRequested) {
        seg.status = 'submitting';
        renderSegmentTable();
        await sleep(1000 * (attempt + 1));
        continue;
      }
      seg.status = 'error';
      seg.error = e.message;
      renderSegmentTable();
      updateProgress();
      return;
    }
  }
}

// KikiVoice helper: upload voice and get voice_id
async function kkUploadVoice(audioFile, speakerName) {
  appLog('[KK] 上传说话人音源: ' + speakerName, 'i');

  // Step 1: Get signature
  var sigData = await kGet('/get-sig');
  if (sigData.error_code !== 0) {
    appLog('[KK] 获取签名失败', 'e');
    return null;
  }
  var sig = sigData.sig || sigData.data?.sig || '';
  var createUrl = sigData.create_url || sigData.data?.create_url || '';

  if (!sig || !createUrl) {
    appLog('[KK] 签名数据不完整', 'e');
    return null;
  }

  // Step 2: Upload voice file
  try {
    var wavBlob = audioFile.wavBlob;
    if (!wavBlob) {
      // Need to create wav from base64
      var audioBytes = Uint8Array.from(atob(audioFile.base64), function(c) { return c.charCodeAt(0); });
      wavBlob = new Blob([audioBytes], { type: 'audio/wav' });
    }

    var formData = new FormData();
    formData.append('voice-file', wavBlob, speakerName + '.wav');
    formData.append('sig', sig);
    formData.append('create_url', createUrl);
    formData.append('voice_name', speakerName + '_' + Date.now());

    var uploadResp = await fetch('/api/kiki/upload-voice?uuid=' + encodeURIComponent(S.kkUuid), {
      method: 'POST',
      body: formData
    });

    var uploadData;
    try { uploadData = await uploadResp.json(); } catch(e) { uploadData = {}; }
    appLog('[KK] 上传结果: ' + JSON.stringify(uploadData).substring(0, 300), 'i');

    if (uploadData.error_code === 0 || uploadData.voice_id) {
      return uploadData.voice_id || uploadData.data?.voice_id;
    }

    // May need Geetest verification
    if (uploadData.validation_url_path || uploadData.error_code === 40001) {
      appLog('[KK] 需要人机验证', 'w');
      var vpath = uploadData.validation_url_path || '';
      var wip = uploadData.worker_ip || '';
      showCFPanel(vpath, wip, JSON.stringify(uploadData));
      await waitForCFVerification();
      // Retry upload after verification
      return await kkUploadVoice(audioFile, speakerName);
    }

    return null;
  } catch(e) {
    appLog('[KK] 上传音源失败: ' + e.message, 'e');
    return null;
  }
}

async function kkGenerateSegmentWithVoice(seg, voiceId, segIdx) {
  seg.status = 'submitting';
  renderSegmentTable();

  var gender = document.getElementById('kGender') ? parseInt(document.getElementById('kGender').value) : 0;
  var speed = document.getElementById('kSpeed') ? parseFloat(document.getElementById('kSpeed').value) : 1.0;
  var volume = document.getElementById('kVolume') ? parseInt(document.getElementById('kVolume').value) : 100;
  var emotion = document.getElementById('kEmotion') ? document.getElementById('kEmotion').value : 'normal';
  var intensity = document.getElementById('kIntensity') ? document.getElementById('kIntensity').value : 'normal';
  var hq = document.getElementById('kHq') ? parseInt(document.getElementById('kHq').value) : 0;

  var body = {
    text: seg.text,
    voice_id: voiceId,
    lang_code: 'zh-cn',
    emotion: emotion,
    intensity: intensity,
    gender: gender,
    model_type: S.kkModel,
    speed: speed,
    volume: volume,
    format: 'mp3',
    hq: hq,
    mver: 'default'
  };

  try {
    var createResp = await kPost('/create-clone-task', body);
    if (createResp.error_code === 40001 || createResp.validation_url_path) {
      var vpath = createResp.validation_url_path || '';
      var wip = createResp.worker_ip || '';
      showCFPanel(vpath, wip, JSON.stringify(createResp));
      await waitForCFVerification();
      createResp = await kPost('/create-clone-task', body);
    }

    if (createResp.error_code !== 0 || !createResp.job_id) {
      throw new Error(createResp.msg || '创建任务失败');
    }

    var jobId = createResp.job_id;
    seg.jobId = jobId;
    seg.status = 'processing';
    renderSegmentTable();

    // Poll for result
    for (var p = 0; p < 120; p++) {
      if (S.cancelRequested) { seg.status = 'cancelled'; renderSegmentTable(); return; }
      await sleep(2000);
      var statusData = await kGet('/job-status?job_id=' + encodeURIComponent(jobId));
      if (statusData.error_code === 0 && statusData.status === 'completed' && statusData.audio_url) {
        var audioResp = await fetch('/api/kiki-audio?url=' + encodeURIComponent(statusData.audio_url));
        if (audioResp.ok) {
          var blob = await audioResp.blob();
          seg.audioBlob = blob;
          try { var ac = new (window.AudioContext||window.webkitAudioContext)(); var ab = await ac.decodeAudioData(await blob.arrayBuffer()); seg.duration = ab.duration; ac.close(); } catch(de) { seg.duration = blob.size / (24000*2); }
          seg.status = 'done';
          appLog('[KK] 段' + (segIdx+1) + ' OK (' + (seg.speaker || '默认') + ')', 's');
        } else {
          seg.status = 'error';
          seg.error = '下载音频失败';
        }
        renderSegmentTable();
        updateProgress();
        return;
      }
      if (statusData.status === 'failed') {
        throw new Error('KikiVoice生成失败');
      }
    }
    throw new Error('KikiVoice轮询超时');
  } catch(e) {
    seg.status = S.cancelRequested ? 'cancelled' : 'error';
    if (!S.cancelRequested) seg.error = e.message;
    appLog('[KK] 段' + (segIdx+1) + ' 失败: ' + e.message, 'e');
    renderSegmentTable();
    updateProgress();
  }
}

function cancelGenerate() {
  S.cancelRequested = true;
  showToast('正在取消...', 'info');
}

function updateProgress() {
  var total = S.segments.length;
  var done = S.segments.filter(function(s) { return s.status === 'done' || s.status === 'error' || s.status === 'cancelled'; }).length;
  var pct = total > 0 ? Math.round(done / total * 100) : 0;
  E.progressFill.style.width = pct + '%';
}

function updateElapsed() {
  var elapsed = Math.floor((Date.now() - S.elapsedStart) / 1000);
  var min = Math.floor(elapsed / 60);
  var sec = elapsed % 60;
  E.elapsed.textContent = '已用时: ' + (min > 0 ? min + 'm ' : '') + sec + 's';
}

function renderSegmentTable() {
  var table = E.segTable;
  var tbody = E.segBody;
  if (S.segments.length === 0) { table.style.display = 'none'; return; }
  table.style.display = 'table';
  // Build speaker index map for color coding
  var spIndexMap = {};
  for (var sdi = 0; sdi < S.detectedSpeakers.length; sdi++) {
    spIndexMap[S.detectedSpeakers[sdi].name] = sdi;
  }
  var html = '';
  S.segments.forEach(function(seg, i) {
    var statusLabel = { 'pending': '等待', 'cloning': '克隆', 'submitting': '提交', 'processing': '生成', 'done': '完成', 'error': '失败', 'cancelled': '取消' }[seg.status] || seg.status;
    var durText = seg.duration > 0 ? seg.duration.toFixed(1) + 's' : '-';
    var shortText = seg.text.length > 40 ? seg.text.substring(0, 40) + '...' : seg.text;
    var speakerBadge = '';
    if (seg.speaker && S.speakerMode === 'multi') {
      var spIdx = spIndexMap[seg.speaker];
      if (spIdx === undefined) spIdx = 0;
      speakerBadge = '<span class="seg-speaker sp' + (spIdx % 5) + '">' + escHtml(seg.speaker) + '</span>';
    }
    html += '<tr>';
    html += '<td>' + (i + 1) + '</td>';
    html += '<td class="seg-text" title="' + escHtml(seg.text) + '">' + speakerBadge + escHtml(shortText) + '</td>';
    html += '<td><div class="seg-status"><span class="sd ' + seg.status + '"></span>' + statusLabel + '</div></td>';
    html += '<td>' + durText + '</td>';
    html += '</tr>';
  });
  tbody.innerHTML = html;
}

// ==================== Audio Concatenation ====================
async function concatenateAudio() {
  var successSegs = S.segments.filter(function(s) { return s.status === 'done' && s.audioBlob; });
  if (successSegs.length === 0) throw new Error('No audio segments');

  var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  S.segmentBuffers = [];
  S.segmentDurations = [];

  for (var i = 0; i < successSegs.length; i++) {
    var arrayBuffer = await successSegs[i].audioBlob.arrayBuffer();
    var audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    S.segmentBuffers.push(audioBuffer);
    S.segmentDurations.push(audioBuffer.duration);
  }

  var totalDuration = 0;
  var sampleRate = S.segmentBuffers[0].sampleRate;
  var numberOfChannels = S.segmentBuffers[0].numberOfChannels;
  for (var i = 0; i < S.segmentBuffers.length; i++) {
    totalDuration += S.segmentBuffers[i].duration;
    sampleRate = Math.max(sampleRate, S.segmentBuffers[i].sampleRate);
  }

  var totalSamples = Math.ceil(totalDuration * sampleRate);
  var resultBuffer = audioCtx.createBuffer(numberOfChannels, totalSamples, sampleRate);

  var offset = 0;
  for (var i = 0; i < S.segmentBuffers.length; i++) {
    var buf = S.segmentBuffers[i];
    for (var ch = 0; ch < numberOfChannels; ch++) {
      var sourceData = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      resultBuffer.copyToChannel(sourceData, ch, offset);
    }
    offset += buf.length;
  }
  audioCtx.close();
  S.resultWavBlob = audioBufferToWav(resultBuffer);
}

// ==================== WAV Encoding ====================
function audioBufferToWav(buffer) {
  var numChannels = buffer.numberOfChannels;
  var sampleRate = buffer.sampleRate;
  var bitDepth = 16;
  var bytesPerSample = bitDepth / 8;
  var blockAlign = numChannels * bytesPerSample;
  var dataLength = buffer.length * blockAlign;
  var totalLength = 44 + dataLength;
  var arrayBuffer = new ArrayBuffer(totalLength);
  var view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  var channels = [];
  for (var ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
  var offset = 44;
  for (var i = 0; i < buffer.length; i++) {
    for (var ch = 0; ch < numChannels; ch++) {
      var sample = Math.max(-1, Math.min(1, channels[ch][i]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample | 0, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (var i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}

// ==================== SRT Generation ====================
function generateSrt() {
  if (S.speakerMode === 'multi') {
    generateSrtMultiSpeaker();
    return;
  }
  var srt = '';
  var subtitleIndex = 1;
  var timeOffset = 0;

  // Use the new reliable line-to-segment mapping
  var segMap = mapOriginalLinesToSegments();

  for (var mi = 0; mi < segMap.length; mi++) {
    var entry = segMap[mi];
    var segDuration = S.segmentDurations[entry.bufIdx] || S.segments[entry.segIdx].duration;

    // Calculate total chars for proportional timing within this segment
    var totalChars = 0;
    for (var li = 0; li < entry.lines.length; li++) totalChars += entry.lines[li].text.length;
    if (totalChars === 0) totalChars = 1;

    var lineOffset = timeOffset;
    for (var li = 0; li < entry.lines.length; li++) {
      var lineText = entry.lines[li].text;
      // Proportional duration based on character count
      var lineDuration = (lineText.length / totalChars) * segDuration;
      var cleanText = cleanSubtitleText(lineText);
      if (cleanText) {
        srt += subtitleIndex + '\\n';
        srt += formatSrtTime(lineOffset) + ' --> ' + formatSrtTime(lineOffset + lineDuration) + '\\n';
        srt += cleanText + '\\n\\n';
        subtitleIndex++;
      }
      lineOffset += lineDuration;
    }
    timeOffset += segDuration;
  }
  S.resultSrt = srt;
}

// Multi-speaker SRT: uses segment's built-in lines & speaker info
// (avoids the buggy mapOriginalLinesToSegments which compares raw input with markers
//  against segment text that has markers stripped, causing character-count mismatch)
function generateSrtMultiSpeaker() {
  var srt = '';
  var subtitleIndex = 1;
  var timeOffset = 0;
  var bufIdx = 0;

  for (var si = 0; si < S.segments.length; si++) {
    var seg = S.segments[si];
    if (seg.status !== 'done') continue;

    var segDuration = S.segmentDurations[bufIdx] || seg.duration;
    bufIdx++;

    // Each segment has a 'lines' array from splitTextForTTS (content text without markers)
    var segLines = seg.lines || [];
    // If no lines tracked, auto-break the segment text
    if (segLines.length === 0) {
      segLines = autoBreakSubtitle(seg.text, 15, 5).map(function(t) { return { text: t }; });
    }

    // Calculate total chars for proportional timing
    var totalChars = 0;
    for (var li = 0; li < segLines.length; li++) totalChars += (segLines[li].text || '').length;
    if (totalChars === 0) totalChars = 1;

    var lineOffset = timeOffset;
    for (var li = 0; li < segLines.length; li++) {
      var lineText = segLines[li].text || '';
      var lineDuration = (lineText.length / totalChars) * segDuration;
      var cleanText = cleanSubtitleText(lineText);
      if (cleanText) {
        srt += subtitleIndex + '\\n';
        srt += formatSrtTime(lineOffset) + ' --> ' + formatSrtTime(lineOffset + lineDuration) + '\\n';
        if (seg.speaker) {
          cleanText = seg.speaker + '：' + cleanText;
        }
        srt += cleanText + '\\n\\n';
        subtitleIndex++;
      }
      lineOffset += lineDuration;
    }
    timeOffset += segDuration;
  }
  S.resultSrt = srt;
}

// Auto-break text into subtitle lines
// maxLen: max chars per line (including punctuation), default 15
// minLen: min chars per line, default 5
function autoBreakSubtitle(text, maxLen, minLen) {
  if (!text || !text.trim()) return [];
  text = text.trim();
  if (!maxLen) maxLen = 15;
  if (!minLen) minLen = 5;
  if (text.length <= maxLen) return [text];

  // Step 1: Split at punctuation boundaries
  var chunks = [];
  var majorRe = /[，。！？；]/g;
  var last = 0, m;
  while ((m = majorRe.exec(text)) !== null) {
    var c = text.substring(last, m.index + 1);
    if (c) chunks.push(c);
    last = m.index + 1;
  }
  if (last < text.length) chunks.push(text.substring(last));

  // Sub-split chunks exceeding maxLen at minor punctuation
  var refined = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    if (chunks[ci].length <= maxLen) { refined.push(chunks[ci]); continue; }
    var subRe = /[、：""''《》…—,\s;:\-]/g;
    var subLast = 0, sm;
    while ((sm = subRe.exec(chunks[ci])) !== null) {
      var sc = chunks[ci].substring(subLast, sm.index + 1);
      if (sc) refined.push(sc);
      subLast = sm.index + 1;
    }
    if (subLast < chunks[ci].length) refined.push(chunks[ci].substring(subLast));
    if (refined.length === 0) refined.push(chunks[ci]);
  }

  // Step 2: Merge chunks into lines up to maxLen
  var lines = [];
  var cur = '';
  for (var ri = 0; ri < refined.length; ri++) {
    if (cur.length + refined[ri].length <= maxLen) {
      cur += refined[ri];
    } else {
      if (cur) lines.push(cur);
      cur = refined[ri];
    }
  }
  if (cur) lines.push(cur);

  // Step 3: Force-split long lines + merge short lines + clean trailing punctuation
  var result = [];
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    while (line.length > maxLen) {
      var sp = maxLen;
      for (var off = 0; off <= 8 && sp - off > minLen; off++) {
        if (/[，。！？、；：""''《》…—,\s;:\-]/.test(line[sp - off])) { sp = sp - off + 1; break; }
      }
      result.push(line.substring(0, sp));
      line = line.substring(sp);
    }
    if (line) result.push(line);
  }

  // Merge short lines with neighbors
  var merged = [];
  for (var fi = 0; fi < result.length; fi++) {
    var cleaned = result[fi].replace(/[，,。.]+$/, '').trim();
    if (!cleaned) continue;
    if (cleaned.length < minLen && merged.length > 0) {
      var prevClean = merged[merged.length - 1].replace(/[，,。.]+$/, '').trim();
      if (prevClean.length + cleaned.length <= maxLen) {
        merged[merged.length - 1] += result[fi];
      } else {
        merged.push(result[fi]);
      }
    } else {
      merged.push(result[fi]);
    }
  }

  return merged;
}

// ==================== Line-to-Segment Mapping ====================
// Map original input lines to TTS segments using character count accumulation.
// This replaces the buggy getLinesInRange approach that caused:
//   - Duplicate lines (when a line spans two segments)
//   - Missing lines (when position tracking was off)
//   - Misaligned SRT timestamps
function mapOriginalLinesToSegments() {
  var inputText = E.textInput.value;
  var rawLines = inputText.split('\\n');
  var originalLines = [];
  for (var i = 0; i < rawLines.length; i++) {
    var trimmed = rawLines[i].trim();
    if (trimmed) originalLines.push(trimmed);
  }

  // Build the mapping: each segment gets its original lines
  var linePtr = 0; // current position in originalLines
  var result = [];  // array of { segIdx, bufIdx, lines: [{text, charStart, charEnd}] }

  var bufIdx = 0;
  for (var si = 0; si < S.segments.length; si++) {
    var seg = S.segments[si];
    if (seg.status !== 'done') continue;

    var segText = seg.text;
    var segTextLen = seg.text.length;
    var segLines = [];
    var accumulatedLen = 0;

    while (linePtr < originalLines.length) {
      var lineText = originalLines[linePtr];
      var newLen = accumulatedLen + (accumulatedLen > 0 ? 1 : 0) + lineText.length;

      // Check if adding this line would exceed the segment text length
      // Allow small tolerance (+3) for minor discrepancies from punctuation/space differences
      if (newLen <= segTextLen + 3) {
        var charStart = accumulatedLen; // position within the segment text
        segLines.push({ text: lineText, charStart: charStart, charEnd: charStart + lineText.length });
        accumulatedLen = newLen;
        linePtr++;
      } else {
        break;
      }
    }

    if (segLines.length === 0) {
      // Fallback: no lines mapped (shouldn't happen normally), use autoBreakSubtitle
      var autoLines = autoBreakSubtitle(segText, 15, 5);
      for (var ai = 0; ai < autoLines.length; ai++) {
        var aCharStart = ai === 0 ? 0 : segLines.length > 0 ? segLines[segLines.length - 1].charEnd : 0;
        segLines.push({ text: autoLines[ai], charStart: aCharStart, charEnd: aCharStart + autoLines[ai].length });
      }
    }

    result.push({ segIdx: si, bufIdx: bufIdx, lines: segLines });
    bufIdx++;
  }

  // Handle remaining original lines that weren't mapped to any segment
  // (e.g., if the last segments failed)
  while (linePtr < originalLines.length) {
    // Assign remaining lines to the last segment if possible, or create estimated entries
    if (result.length > 0) {
      var lastEntry = result[result.length - 1];
      lastEntry.lines.push({ text: originalLines[linePtr], charStart: -1, charEnd: -1 });
    }
    linePtr++;
  }

  return result;
}

function cleanSubtitleText(text) {
  if (!text) return '';
  text = text.trim();
  if (!text) return '';
  // Remove trailing commas and periods, but keep ！？""''《》…—
  text = text.replace(/[，,。.]+$/, '');
  return text;
}

function formatSrtTime(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var ms = Math.round((seconds % 1) * 1000);
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ',' + pad3(ms);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n); }

// ==================== JianYing Project ZIP ====================
async function downloadJianYing() {
  await loadJSZip();
  if (!S.resultWavBlob) { showToast('请先生成音频', 'error'); return; }
  showToast('正在生成剪映工程...', 'info');
  try {
    var zip = new JSZip();
    var successSegs = S.segments.filter(function(s) { return s.status === 'done'; });
    if (successSegs.length === 0) { showToast('无可用音频段', 'error'); return; }

    // Project folder inside ZIP
    var projectName = S.projectName || 'TTS_Voice_Lab';
    var projectFolder = zip.folder(projectName);

    var audioMaterials = [], audioSegments = [], textMaterials = [], textSegments = [], speedMaterials = [];

    // ===== Calculate total duration =====
    var totalDurationUs = 0;
    var bufIdx = 0;
    var segTimeOffsets = []; // track start time of each segment in microseconds
    var segDurationsUs = []; // track duration of each segment in microseconds
    for (var si = 0; si < S.segments.length; si++) {
      if (S.segments[si].status !== 'done') continue;
      var segDurationSec = S.segmentDurations[bufIdx] || S.segments[si].duration;
      var segDurationUs = Math.round(segDurationSec * 1000000);
      segTimeOffsets.push(totalDurationUs);
      segDurationsUs.push(segDurationUs);
      totalDurationUs += segDurationUs;
      bufIdx++;
    }

    // ===== Single complete audio file =====
    var audioFileName = 'audio_main.wav';
    var audioArrayBuffer = await S.resultWavBlob.arrayBuffer();
    projectFolder.file(audioFileName, audioArrayBuffer);

    // Also include SRT in the project folder
    if (S.resultSrt) {
      projectFolder.file('audio_main.srt', S.resultSrt);
    }

    var audioMatId = hexId(), audioSegId = hexId(), audioSpeedId = hexId();
    audioMaterials.push({
      id: audioMatId, local_material_id: audioMatId, music_id: audioMatId,
      name: audioFileName, path: './' + audioFileName,
      duration: totalDurationUs, type: 'extract_music', category_name: 'local',
      check_flag: 3, local_id: '', source_platform: 0, source: 0, text_id: '', text_source: 0
    });
    speedMaterials.push({ id: audioSpeedId, speed: 1.0, mode: 0, type: 'speed' });
    audioSegments.push({
      id: audioSegId, material_id: audioMatId,
      target_timerange: { start: 0, duration: totalDurationUs },
      source_timerange: { start: 0, duration: totalDurationUs },
      speed: 1.0, volume: 1.0, extra_material_refs: [audioSpeedId],
      is_tone_modify: false, clip: null, render_index: 0, role: 0,
      group_id: '', track_attribute: 0, uniform_scale: null, source: 0
    });

    // ===== Subtitle segments =====
    var subtitleIndex = 0;
    // For multi-speaker mode, use segment's built-in lines to avoid marker mismatch
    var jySubtitleEntries = [];
    if (S.speakerMode === 'multi') {
      var jyBufIdx = 0;
      for (var si2 = 0; si2 < S.segments.length; si2++) {
        var seg2 = S.segments[si2];
        if (seg2.status !== 'done') continue;
        var jyLines = seg2.lines || [];
        if (jyLines.length === 0) {
          jyLines = autoBreakSubtitle(seg2.text, 15, 5).map(function(t) { return { text: t }; });
        }
        jySubtitleEntries.push({ bufIdx: jyBufIdx, lines: jyLines, speaker: seg2.speaker });
        jyBufIdx++;
      }
    } else {
      var segMap = mapOriginalLinesToSegments();
      for (var mi2 = 0; mi2 < segMap.length; mi2++) {
        jySubtitleEntries.push({ bufIdx: segMap[mi2].bufIdx, lines: segMap[mi2].lines, speaker: null });
      }
    }

    for (var ji = 0; ji < jySubtitleEntries.length; ji++) {
      var jyEntry = jySubtitleEntries[ji];
      var segDurationUs2 = segDurationsUs[jyEntry.bufIdx];
      var timeOffsetUs = segTimeOffsets[jyEntry.bufIdx];

      // Calculate total chars for proportional timing
      var totalChars = 0;
      for (var li = 0; li < jyEntry.lines.length; li++) totalChars += (jyEntry.lines[li].text || '').length;
      if (totalChars === 0) totalChars = 1;

      var lineOffsetUs = timeOffsetUs;
      for (var li = 0; li < jyEntry.lines.length; li++) {
        var lineText = jyEntry.lines[li].text || '';
        var lineDurationUs = Math.round((lineText.length / totalChars) * segDurationUs2);
        var cleanText = cleanSubtitleText(lineText);
        // Add speaker label in multi-speaker mode
        if (S.speakerMode === 'multi' && jyEntry.speaker) {
          cleanText = jyEntry.speaker + '：' + cleanText;
        }
        if (cleanText) {
          var textMatId = hexId(), textSegId = hexId(), textSpeedId = hexId();
          var textContent = JSON.stringify({
            styles: [{
              fill: { alpha: 1.0, content: { render_type: 'solid', solid: { alpha: 1.0, color: [1.0, 1.0, 1.0] } } },
              range: [0, cleanText.length], size: 10.0,
              strokes: [{ content: { solid: { alpha: 1.0, color: [0.0, 0.0, 0.0] } }, width: 0.08 }],
              bold: false, italic: false, underline: false
            }],
            text: cleanText
          });
          textMaterials.push({
            id: textMatId, content: textContent, type: 'subtitle',
            typesetting: 0, alignment: 1,
            letter_spacing: 0.0, line_spacing: 0.02,
            line_feed: 1, line_max_width: 0.82, force_apply_line_max_width: false,
            check_flag: 15, global_alpha: 1.0,
            font_id: 'NotoSansSC', font_name: '\u601d\u6e90\u9ed1\u4f53', font_size: 10.0,
            local_id: '', source: 0, text_id: '', text_source: 0,
            path: '', category_id: '', category_name: 'local'
          });
          speedMaterials.push({ id: textSpeedId, speed: 1.0, mode: 0, type: 'speed' });
          textSegments.push({
            id: textSegId, material_id: textMatId,
            target_timerange: { start: lineOffsetUs, duration: lineDurationUs },
            source_timerange: null, speed: 1.0, volume: 1.0,
            clip: { alpha: 1.0, flip: { horizontal: false, vertical: false }, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: -0.8 } },
            uniform_scale: { on: true, value: 1.0 }, extra_material_refs: [textSpeedId],
            common_keyframes: [], keyframe_refs: [],
            enable_adjust: true, enable_color_correct_adjust: false,
            enable_color_curves: true, enable_color_match_adjust: false,
            enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false,
            is_tone_modify: false, last_nonzero_volume: 1.0,
            reverse: false, track_attribute: 0, track_render_index: 0, visible: true
          });
          subtitleIndex++;
        }
        lineOffsetUs += lineDurationUs;
      }
    }

    var draftId = hexId().toUpperCase();
    var draftIdDashed = draftId.substring(0, 8) + '-' + draftId.substring(8, 12) + '-' + draftId.substring(12, 16) + '-' + draftId.substring(16, 20) + '-' + draftId.substring(20, 32);

    var draftContent = {
      id: draftIdDashed,
      canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
      duration: totalDurationUs,
      materials: {
        videos: [], audios: audioMaterials, texts: textMaterials, images: [],
        speeds: speedMaterials, transitions: [], digital_humans: [], material_animations: [],
        effects: [], filters: [], stickers: [], masks: [], ai_transcriptions: [], auto_captions: [],
        sound_channel_mappings: [], bezier_curves: [], clouds: [], flowers: [], frames: [],
        hands: [], head_animations: [], log_color_wheels: [], magic_colors: [], material_colors: [],
        multi_language_refs: [], placeholders: [], primary_color_wheels: [], realtime_denoises: [],
        shape_templates: [], smart_crops: [], sound_effect_metadatas: [], text_templates: [],
        track_groups: [], video_effects: [], video_track_animations: [], vocal_beautifys: [],
        vocal_falsettos: [], video_generators: [],
        crop: { lower_left_x: 0, lower_left_y: 1, upper_right_x: 1, upper_right_y: 0 },
        personality_speaker_infos: [], ocr_text_labels: [], smart_relights: [], materials_changers: [],
        group_res: [], chaos_contents: [], virtual_projections: [], audio_fades: [], audio_effects: [],
        color_curves: [], material_labels: []
      },
      tracks: [
        { id: hexId(), type: 'audio', attribute: 0, flag: 0, is_default: false, segments: audioSegments, track_duration: totalDurationUs },
        { id: hexId(), type: 'text', attribute: 0, flag: 0, is_default: false, segments: textSegments, track_duration: totalDurationUs }
      ],
      metadata: { app_id: 1, app_version: '5.0.0', create_time: Date.now(), draft_id: draftIdDashed, draft_name: projectName, platform: 'windows', source: 0, timeline_materials_size_: 0, timeline_size_: 0, version: 1 },
      last_modified_platform: 'windows', name: projectName, new_version: '',
      platform: { os: 'windows', device: '' }, relationships: [], retouch_cover: '', source: 'default',
      update_time: Date.now(), version: 1
    };

    projectFolder.file('draft_content.json', JSON.stringify(draftContent, null, 2));
    var metaInfo = {
      draft_id: draftIdDashed, draft_name: projectName, draft_deeplink: '', draft_cover: '',
      draft_materials_covers: [], timeline_materials_size_: 0, create_time: Date.now(), update_time: Date.now(),
      is_from_ugc_template: false, is_draft_removed: false, is_invisible: false, source: 'default',
      tm_draft_cloud_id: '', tm_draft_cloud_resource_id: '', draft_cloud_purchase_info: '',
      is_commercialize_music_licensed: false
    };
    projectFolder.file('draft_meta_info.json', JSON.stringify(metaInfo, null, 2));

    var zipBlob = await zip.generateAsync({ type: 'blob' });
    var filename = getDownloadFilename('zip');
    downloadBlob(zipBlob, filename);
    showToast('剪映工程已下载', 'success');
  } catch(e) {
    showToast('生成剪映工程失败: ' + e.message, 'error');
  }
}

// ==================== Downloads ====================
function downloadWav() {
  if (!S.resultWavBlob) { showToast('请先生成音频', 'error'); return; }
  // Direct download from existing blob - no re-synthesis
  downloadBlob(S.resultWavBlob, getDownloadFilename('wav'));
}

function downloadSrt() {
  if (!S.resultSrt) { showToast('请先生成音频', 'error'); return; }
  downloadBlob(new Blob([S.resultSrt], { type: 'text/plain;charset=utf-8' }), getDownloadFilename('srt'));
}

function getDownloadFilename(ext) {
  var name = S.projectName || S.downloadTimestamp || (function() {
    var now = new Date();
    return '' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '-' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
  })();
  return name + '.' + ext;
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ==================== Import/Export ====================
function exportConfig() {
  saveConfig();
  var exportData = {
    version: APP_VERSION,
    config: S.config,
    audioSources: S.audioSources.map(function(src) {
      return { id: src.id, name: src.name, dataUrl: src.dataUrl, nvReferenceId: src.nvReferenceId, addedAt: src.addedAt };
    })
  };
  downloadBlob(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }), 'tts-voice-lab-config.json');
  showToast('配置已导出', 'success');
}

function importConfig(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (data.config) {
        Object.keys(data.config).forEach(function(k) { if (S.config[k] !== undefined) S.config[k] = data.config[k]; });
        saveConfig(); applyConfigToUI();
        switchEngine(S.config.engine || 'nicevoice');
      }
      if (data.audioSources && Array.isArray(data.audioSources)) {
        data.audioSources.forEach(function(src) {
          if (!S.audioSources.find(function(s) { return s.name === src.name; })) S.audioSources.push(src);
        });
        saveAudioSources(); renderSourceList(); renderSourceSelect();
      }
      showToast('配置已导入', 'success');
      checkApiStatus();
    } catch(err) { showToast('导入失败: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ==================== Settings Panel ====================
function toggleSettings() {
  var panel = E.settingsPanel;
  var overlay = E.settingsOverlay;
  if (panel.classList.contains('open')) {
    panel.classList.remove('open'); overlay.classList.remove('open');
    saveConfig(); checkApiStatus();
  } else {
    applyConfigToUI(); panel.classList.add('open'); overlay.classList.add('open');
  }
}

// ==================== History ====================
var historyDB = null;

function openHistoryDB() {
  return new Promise(function(resolve, reject) {
    if (historyDB) { resolve(historyDB); return; }
    var req = indexedDB.open('ttsvoicelab_history', 2);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('records')) {
        db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = function(e) { historyDB = e.target.result; resolve(historyDB); };
    req.onerror = function(e) { reject(e.target.error); };
  });
}

function openHistory() { renderHistoryList(); E.historyModal.classList.add('open'); }
function closeHistory() { E.historyModal.classList.remove('open'); }

async function addHistory(entry) {
  try {
    var db = await openHistoryDB();
    var tx = db.transaction('records', 'readwrite');
    var store = tx.objectStore('records');
    // Store audio blob reference and SRT text
    entry.wavBlob = S.resultWavBlob;
    entry.srtText = S.resultSrt;
    entry.projectName = S.projectName || S.downloadTimestamp || 'audio';
    store.add(entry);

    // Trim to maxHistory
    var countReq = store.count();
    countReq.onsuccess = function() {
      var count = countReq.result;
      if (count > (S.config.maxHistory || 10)) {
        // Get all keys, delete oldest
        var allReq = store.getAllKeys();
        allReq.onsuccess = function() {
          var keys = allReq.result;
          var toDelete = count - (S.config.maxHistory || 10);
          for (var i = 0; i < toDelete; i++) {
            store.delete(keys[i]);
          }
        };
      }
    };
  } catch(e) {
  }
}

async function clearHistory() {
  try {
    var db = await openHistoryDB();
    var tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').clear();
    renderHistoryList();
    showToast('历史记录已清空', 'success');
  } catch(e) {
    showToast('清空历史失败', 'error');
  }
}

async function renderHistoryList() {
  try {
    var db = await openHistoryDB();
    var tx = db.transaction('records', 'readonly');
    var store = tx.objectStore('records');
    var req = store.getAll();
    req.onsuccess = function() {
      var history = req.result.reverse(); // newest first
      var el = E.historyList;
      if (!history.length) { el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text2)">暂无历史记录</div>'; return; }
      var html = '<div style="text-align:right;margin-bottom:8px"><button class="clear-btn" onclick="clearHistory()">清空历史</button></div>';
      history.forEach(function(item) {
        var engLabel = item.engine === 'nicevoice' ? 'NV' : item.engine === 'kikivoice' ? 'KK' : 'IDX';
        var hasAudio = !!item.wavBlob;
        html += '<div class="history-item">';
        html += '<div class="hi-top"><span class="hi-text">[' + engLabel + '] ' + escHtml(item.projectName || '未命名') + ' — ' + (item.success || 0) + '/' + (item.segments || 0) + ' 段</span><span class="hi-date">' + escHtml(item.date || '') + '</span></div>';
        html += '<div class="hi-detail">' + escHtml(item.text || '') + '</div>';
        if (hasAudio) {
          html += '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">';
          html += '<button class="clear-btn" onclick="downloadHistoryItem(' + item.id + ',\\'wav\\')" style="color:var(--green);border-color:var(--green)">下载 WAV</button>';
          if (item.srtText) html += '<button class="clear-btn" onclick="downloadHistoryItem(' + item.id + ',\\'srt\\')" style="color:var(--blue);border-color:var(--blue)">下载 SRT</button>';
          html += '</div>';
        }
        html += '</div>';
      });
      el.innerHTML = html;
    };
  } catch(e) {
  }
}

async function downloadHistoryItem(id, type) {
  try {
    var db = await openHistoryDB();
    var tx = db.transaction('records', 'readonly');
    var store = tx.objectStore('records');
    var req = store.get(id);
    req.onsuccess = function() {
      var item = req.result;
      if (!item) { showToast('记录不存在', 'error'); return; }
      if (type === 'wav' && item.wavBlob) {
        downloadBlob(item.wavBlob, (item.projectName || 'audio') + '.wav');
      } else if (type === 'srt' && item.srtText) {
        downloadBlob(new Blob([item.srtText], { type: 'text/plain;charset=utf-8' }), (item.projectName || 'audio') + '.srt');
      } else {
        showToast('该类型文件不存在', 'error');
      }
    };
  } catch(e) {
    showToast('下载失败', 'error');
  }
}

// ==================== README ====================
function showReadme() { E.readmeBody.innerHTML = getReadmeContent(); E.readmeModal.classList.add('open'); }
function closeReadme() { E.readmeModal.classList.remove('open'); }

function getReadmeContent() {
  return '<h2>TTS Voice Lab v' + APP_VERSION + '</h2>' +
  '<h3>&#x1F4D6; 简介</h3>' +
  '<p>TTS Voice Lab 是一个基于浏览器的语音克隆TTS工具，支持长文本分段合成、字幕生成和剪映工程导出。</p>' +
  '<p>v2.9 新增 <b>KikiVoice</b> 作为备选TTS引擎（每周 60,000 免费积分），支持三种模型和极验人机验证。</p>' +

  '<h3>&#x1F527; 功能特性</h3>' +
  '<ul>' +
  '<li><b>双引擎支持</b>：NiceVoice（主）+ IndexTTS（备选），一键切换</li>' +
  '<li><b>NiceVoice</b>：免费无限制语音克隆，无需登录，API代理自动签名</li>' +
  '<li><b>IndexTTS</b>：基于 kozzzq/indextts2api REST API，支持并发生成</li>' +
  '<li><b>音源管理</b>：保存、切换多个参考音源，音源可关联克隆ID</li>' +
  '<li><b>长文本分段</b>：NiceVoice 150字/段（智能合并短句），IndexTTS 250字/段</li>' +
  '<li><b>换行保留</b>：原始换行用于字幕分行</li>' +
  '<li><b>Word文档导入</b>：支持拖拽或上传 .docx 文件</li>' +
  '<li><b>SRT字幕</b>：按时间比例分配字幕</li>' +
  '<li><b>剪映工程导出</b>：生成可直接导入剪映的工程ZIP</li>' +
  '<li><b>生成历史</b>：自动保存生成记录，标注使用引擎</li>' +
  '<li><b>配置导入/导出</b>：备份和恢复所有设置和音源</li>' +
  '</ul>' +

  '<h3>&#x1F4CB; 使用方法</h3>' +
  '<ol>' +
  '<li>选择 TTS 引擎（推荐 NiceVoice）</li>' +
  '<li>上传参考音频（5-15秒清晰录音效果最佳）</li>' +
  '<li>输入或导入要合成的文本</li>' +
  '<li>点击"开始合成"，等待生成完成</li>' +
  '<li>下载 WAV 音频、SRT 字幕或剪映工程</li>' +
  '</ol>' +

  '<h3>&#x1F504; 引擎对比</h3>' +
  '<ul>' +
  '<li><b>NiceVoice</b>：免费无限、无需登录、声音克隆质量好、150字/段、段间16秒间隔</li>' +
  '<li><b>IndexTTS</b>：需要自建API或使用公共API、250字/段、支持并发、无间隔限制</li>' +
  '</ul>' +

  '<h3>&#x1F3A4; 关于参考音频</h3>' +
  '<p>参考音频的质量直接影响克隆效果。建议：</p>' +
  '<ul>' +
  '<li>时长5-15秒，清晰无噪音</li>' +
  '<li>避免背景音乐或多人说话</li>' +
  '<li>可以保存多个音源并随时切换</li>' +
  '<li>如需变速效果，请预先处理参考音频，本工具不做变速</li>' +
  '</ul>' +

  '<h3>&#x1F4BD; 关于剪映工程</h3>' +
  '<p>导出的 ZIP 解压后包含以项目名命名的文件夹，内含 draft_content.json、draft_meta_info.json、audio_main.wav 和 audio_main.srt。将文件夹复制到剪映草稿目录 <code>com.lveditor.draft</code> 下即可打开。画布比例：9:16，字幕使用思源黑体（白字黑边，字号10），位于画面下方。音频为完整单段文件。</p>' +

  '<h3 style="margin-top:24px;border-top:1px solid var(--border);padding-top:16px">&#x1F4DD; 更新日志</h3>' +
  '<div class="changelog-version">v2.11.0<span class="changelog-date">2026-06-11</span></div>' +
  '<ul>' +
  '<li><b>多人旁白模式</b>：自动检测文本中的说话人标记（【姓名】和 姓名：两种格式），分配不同音源给不同说话人</li>' +
  '<li><b>换行续接</b>：没有说话人标记的行自动归属上一个说话人</li>' +
  '<li><b>防呆检测</b>：当说话人台词量严重不均衡时，警告可能遗漏了说话人标记</li>' +
  '<li><b>说话人音源分配</b>：检测到多人后，为每位说话人单独分配/上传参考音频</li>' +
  '<li><b>自定义说话人模式</b>：支持添加自定义正则表达式识别说话人，随配置导入导出</li>' +
  '<li><b>多人SRT字幕</b>：字幕自动标注说话人姓名，时间轴精确匹配</li>' +
  '<li><b>多人剪映导出</b>：剪映工程也支持多人字幕标签</li>' +
  '<li><b>工作流优化</b>：先输入文本，检测到多人后再分配音源</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.9.0<span class="changelog-date">2026-05-25</span></div>' +
  '<ul>' +
  '<li><b>新增 KikiVoice 渠道</b>：备选 TTS 引擎，三种免费模型（Core/Pro/Multilingual），每周 60,000 免费积分</li>' +
  '<li><b>Geetest 人机验证</b>：KikiVoice 首次使用需完成滑块验证，验证页面通过 Worker 代理确保 IP 一致</li>' +
  '<li><b>模型选择</b>：KikiVoice 支持 Core(2x)/Pro(3x)/Multilingual(2x) 三种模型</li>' +
  '<li><b>模型参数调节</b>：语速、音量、情感、强度、性别、高品质</li>' +
  '<li><b>积分余量查询</b>：实时显示剩余积分、已用积分和重置时间</li>' +
  '<li><b>Log 控制台</b>：新增事件记录控制台，显示所有引擎的详细日志</li>' +
  '<li><b>三引擎支持</b>：NiceVoice(推荐) + IndexTTS + KikiVoice(备选)</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.8.0<span class="changelog-date">2026-05-26</span></div>' +
  '<ul>' +
  '<li><b>JSZip 懒加载</b>：JSZip 库仅在需要时（DOCX解析/剪映导出）才加载，首屏加载更快</li>' +
  '<li><b>移除调试日志</b>：移除所有控制台日志输出，减少执行开销</li>' +
  '<li><b>简化字幕算法</b>：优化自动换行算法，更精简高效</li>' +
  '<li><b>DOM 元素缓存</b>：缓存常用DOM元素引用，减少重复查询</li>' +
  '<li><b>代码去重</b>：合并XML文本提取公共逻辑</li>' +
  '<li><b>HTTP缓存</b>：添加页面缓存头，减少重复请求</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.7.0<span class="changelog-date">2026-05-25</span></div>' +
  '<ul>' +
  '<li><b>修复SRT时间轴根本问题</b>：弃用 getLinesInRange 位置追踪法（导致开头丢失、句子重复/错位），改用字符数累加法 mapOriginalLinesToSegments，精确映射原始输入行到TTS段</li>' +
  '<li><b>修复剪映字幕同步</b>：剪映导出的字幕段也使用新映射，与SRT保持一致</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.6.0<span class="changelog-date">2026-05-25</span></div>' +
  '<ul>' +
  '<li><b>修复SRT时间轴</b>：修正字幕时间与音频不同步、开头遗漏和重复问题</li>' +
  '<li><b>修复WAV下载</b>：点击下载WAV不再重新合成，直接下载已有文件</li>' +
  '<li><b>文件名规则</b>：导入docx时，文件名与docx一致（如 0525 韩星见面会.wav）</li>' +
  '<li><b>剪映ZIP结构</b>：解压后包含项目名文件夹，内含 draft_content.json / draft_meta_info.json / audio_main.wav / audio_main.srt</li>' +
  '<li><b>音源管理优化</b>：保存和管理音源移至设置面板，生成界面仅切换/使用音源</li>' +
  '<li><b>生成历史升级</b>：使用 IndexedDB 保存最近n条音频和SRT，支持直接从历史下载，n可在设置中调整，可清空</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.5.0<span class="changelog-date">2026-05-25</span></div>' +
  '<ul>' +
  '<li><b>修复剪映字幕显示</b>：字幕类型改为 subtitle，解决原始JSON显示问题</li>' +
  '<li><b>修复字幕样式格式</b>：stroke 格式对齐 pyJianYingDraft 规范，移除 style 中多余字体字段</li>' +
  '<li><b>补全字幕素材字段</b>：添加 typesetting/letter_spacing/line_spacing/line_feed/line_max_width/global_alpha 等必要字段</li>' +
  '<li><b>修复字幕坐标</b>：transform 使用归一化坐标 y:-0.8，字幕正确显示在画面下方</li>' +
  '<li><b>补全字幕段字段</b>：添加 visible/reverse/common_keyframes/enable_adjust 等，确保时间线显示</li>' +
  '<li><b>描边宽度调整</b>：stroke width 从 0.01 调整为 0.08，确保描边可见</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.4.0<span class="changelog-date">2026-05-25</span></div>' +
  '<ul>' +
  '<li><b>规范化文件名</b>：音频 yyyymmdd-hhmmss.wav、SRT yyyymmdd-hhmmss.srt、工程 yyyymmdd-hhmmss.zip、分段 seg_xx.wav</li>' +
  '<li><b>SRT 自动换行</b>：每行不超过15字、不少于5字、以标点分界、均分字数</li>' +
  '<li><b>SRT 标点处理</b>：句末逗号、句号不显示；引号、问号、叹号、省略号、书名号等句末保留</li>' +
  '<li><b>剪映字幕样式</b>：思源黑体、白字黑边、字号10</li>' +
  '<li><b>剪映音频优化</b>：使用完整单一音频文件替代分段切片</li>' +
  '<li><b>同次生成时间戳一致</b>：同一批生成的所有下载文件使用相同时间戳</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.3.0<span class="changelog-date">2026-05-24</span></div>' +
  '<ul>' +
  '<li><b>音色复用优化</b>：保存的音源现在会关联 NiceVoice 服务器端的 referenceId</li>' +
  '<li><b>智能验证</b>：使用已保存音色时，先用 getSyncRefStatus 检查服务器端是否仍有效</li>' +
  '<li><b>自动重新克隆</b>：如果服务器端音色已失效，自动重新克隆并更新本地保存的 referenceId</li>' +
  '<li><b>克隆后自动保存</b>：首次克隆成功后自动将 referenceId 写回对应音源</li>' +
  '<li>减少不必要的重复克隆，节省时间</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.2.0<span class="changelog-date">2026-05-24</span></div>' +
  '<ul>' +
  '<li><b>修复文字分段</b>：NiceVoice 模式下短句不再各自成段，现在会正确合并到150字/段</li>' +
  '<li><b>完整控制台日志</b>：NiceVoice 和 IndexTTS 全流程输出详细日志（带 [NV] / [IDX] / [TTS] / [Audio] / [API] 前缀），方便 F12 调试</li>' +
  '<li>分段逻辑重构：先按标点拆句，再合并至 maxChars，避免出现过多短段</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.1.0<span class="changelog-date">2026-05-24</span></div>' +
  '<ul>' +
  '<li>新增 NiceVoice 作为主要TTS引擎（免费无限语音克隆）</li>' +
  '<li>新增双引擎切换器（NiceVoice / IndexTTS）</li>' +
  '<li>新增 NiceVoice API 代理（服务端 HMAC-SHA256 签名，密钥不暴露）</li>' +
  '<li>新增声音克隆流程：上传 → 训练 → TTS</li>' +
  '<li>新增音源关联克隆ID（同一音源再次使用无需重新训练）</li>' +
  '<li>新增引擎特定设置面板</li>' +
  '<li>优化文本分段：根据引擎自动调整最大字数</li>' +
  '<li>更新 UI：引擎标识、状态颜色区分</li>' +
  '</ul>' +

  '<div class="changelog-version">v2.0.0<span class="changelog-date">2026-05-23</span></div>' +
  '<ul>' +
  '<li>全新重构，基于 kozzzq/indextts2api REST API</li>' +
  '<li>新增剪映工程ZIP导出功能</li>' +
  '<li>新增SRT字幕生成</li>' +
  '<li>新增音源管理</li>' +
  '<li>新增并发TTS生成</li>' +
  '<li>新增生成历史记录</li>' +
  '<li>新增Word文档导入</li>' +
  '<li>新增配置导入/导出</li>' +
  '</ul>';
}

// ==================== Toast & Helpers ====================
function showToast(msg, type) {
  var toast = E.toast;
  toast.textContent = msg;
  toast.className = 'toast ' + (type || 'info');
  toast.offsetHeight;
  toast.classList.add('show');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(function() { toast.classList.remove('show'); }, 3000);
}

function hexId() {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, function() { return (Math.random() * 16 | 0).toString(16); });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
<\/script>
</body>
</html>`;
}
// Deployed: 2026-05-25T14:37:36Z
