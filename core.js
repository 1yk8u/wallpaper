'use strict';
/* =====================================================================
 * core.js —— 公共工具（画廊、设置、解析器共用）
 * ===================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const $id = (i) => document.getElementById(i);

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const escAttr = esc;

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toast(msg, kind) {
  kind = kind || 'ok';
  const box = $id('toasts');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  d.textContent = msg;
  box.appendChild(d);
  requestAnimationFrame(() => d.classList.add('show'));
  setTimeout(() => { d.classList.remove('show'); setTimeout(() => d.remove(), 300); }, 3200);
}

function withTimeout(p, ms, label) {
  ms = ms || 20000; label = label || '请求超时，请稍后重试';
  let t;
  const gate = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([p, gate]).finally(() => clearTimeout(t));
}

/* ---------------- CORS 代理通道（多通道并发竞速 + 冷却降级） ---------------- */
const PROXY_TEXT = [
  { label: 'cors/workers', mk: u => 'https://test.cors.workers.dev/?' + u, bin: true },
  { label: 'allorigins/raw', mk: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u), bin: true },
  { label: 'corsproxy', mk: u => 'https://corsproxy.io/?url=' + encodeURIComponent(u), bin: true },
  { label: 'codetabs', mk: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u), bin: true, noBan: true },
  { label: 'allorigins/get', wrap: async u => {
      const r = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(u));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return new Response((j && j.contents != null) ? String(j.contents) : '', { status: 200, headers: { 'Content-Type': (j && j.contentType) || 'text/plain; charset=utf-8' } });
    }, noBan: true },
  { label: 'cors/eu', mk: u => 'https://cors.eu.org/' + u, bin: true },
  { label: 'jina', mk: u => 'https://r.jina.ai/' + u, textOnly: true }, /* 快照文本,适合页面元数据 */
];
/* 支持 POST 转发的通道（快手 GraphQL 用）：
 * cors/workers 是防备通道——不参与正常竞争、永不拉黑，普通通道全灭才启用 */
const POST_PROXIES = [
  { label: 'cors/lol', mk: u => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
  { label: 'cors/workers', mk: u => 'https://test.cors.workers.dev/?' + u, noBan: true },
];
/* 兼容旧名字（批量搬运等既有代码） */
const TEXT_PROXIES = PROXY_TEXT;

/* 通道冷却状态：失败的通道 10 分钟内排到队尾，直连失败 5 分钟内不再抢第一 */
const PXKEY = 'wp_px_state_v1';
function pxState() { try { return JSON.parse(localStorage.getItem(PXKEY) || '{}'); } catch (e) { return {}; } }
function pxPenalize(label, ms) {
  const s = pxState(); s[label] = Date.now() + (ms || 6e5);
  try { localStorage.setItem(PXKEY, JSON.stringify(s)); } catch (e) {}
}
function pxRank(label) { const t = pxState()[label]; return (typeof t === 'number' && t < Date.now()) ? 1 : 0; }

/* 通道拉黑（本机自动删除）：连续 2 次真实解析失败 → 本机禁用 24 小时，
 * 等效于「把不能用的通道删掉」，期满自动重生，成功即清零。仅影响本设备。 */
const BANKEY = 'wp_px_ban_v1';
function pxBanState() { try { return JSON.parse(localStorage.getItem(BANKEY) || '{}'); } catch (e) { return {}; } }
function pxSaveBan(s) { try { localStorage.setItem(BANKEY, JSON.stringify(s)); } catch (e) {} }
function pxIsBanned(label) { const e = pxBanState()[label]; return !!(e && e.banUntil > Date.now()); }
function pxMarkFail(label) {
  const s = pxBanState();
  const e = s[label] || { strikes: 0, banUntil: 0 };
  e.strikes = (typeof e.strikes === 'number' ? e.strikes : 0) + 1;
  if (e.strikes >= 2) { e.banUntil = Date.now() + 864e5; e.strikes = 0; }
  s[label] = e;
  pxSaveBan(s);
}
function pxMarkOk(label) {
  const s = pxBanState();
  if (s[label]) { delete s[label]; pxSaveBan(s); }
}

/* 通道速度档案：recordRTT 记录每次真实成功耗时；30 分钟内有效。
 * 解析页打开时会先行「打探」一轮测速（probeChannels），最快通道直接梦开始。 */
const RTTKEY = 'wp_px_rtt_v1';
function pxRTT() { try { return JSON.parse(localStorage.getItem(RTTKEY) || '{}'); } catch (e) { return {}; } }
function recordRTT(label, ms) {
  if (typeof label !== 'string' || !(ms > 0) || ms > 30000) return;
  const t = pxRTT();
  const old = t[label];
  if (old && old.at && Date.now() - old.at < 18e5 && old.ms <= ms) return; /* 30 分钟内保留最好成绩 */
  t[label] = { ms: Math.round(ms), at: Date.now() };
  try { localStorage.setItem(RTTKEY, JSON.stringify(t)); } catch (e) {}
}
function rttOf(label) {
  const e = pxRTT()[label];
  return (e && e.at && Date.now() - e.at < 18e5) ? e.ms : null;
}

/* 通道排序：被惩罚的垫底 → 有测速记录的速度优先 → 没记录的殿后 */
function orderedChannels(chans) {
  return chans.slice().sort((a, b) => {
    const pr = pxRank(a.label) - pxRank(b.label);
    if (pr) return pr;
    const ra = rttOf(a.label), rb = rttOf(b.label);
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}

/* 打探一轮：给每条通道发个极小请求测延迟，成功记 RTT，失败轻惩罚 3 分钟 */
const PROBE_TARGET = 'https://www.baidu.com/favicon.ico';
/* 按「通道组」分别上锁：以前一个全局锁会让 POST 通道的测速直接被跳过 */
const probeBusy = new Set();
async function probeChannels(chans, opt) {
  opt = opt || {};
  const lockKey = (chans[0] && chans[0].label) || 'default';
  if (probeBusy.has(lockKey)) return;
  probeBusy.add(lockKey);
  const ms = opt.ms || 5500;
  try {
    await Promise.allSettled(chans.filter(c => c.mk && !c.wrap && !c.noBan).map(async (c) => {
      const t0 = performance.now();
      try {
        const r = await withTimeout(fetch(c.mk(PROBE_TARGET)), ms, c.label + ' 探测超时');
        if (r) recordRTT(c.label, performance.now() - t0);
      } catch (e) { pxPenalize(c.label, 18e4); }
    }));
  } finally { probeBusy.delete(lockKey); }
}

/* 滚动双车道竞速：任何一条成功「瞬间」全局返回，绝不陪跑慢通道；
 * 车道数 = wave（默认 2），一条落地立即补发下一条，失败通道进冷却队列。
 * 被拉黑的通道（连续两败）不参与发射；全员拉黑时兜底解禁防锁死。 */
async function raceFetch(chans, url, opt) {
  opt = opt || {};
  const ms = opt.ms || 20000;
  const cap = Math.max(1, opt.wave || 2);
  const pool = chans.filter(c => (opt.binary ? !c.textOnly : true));
  /* 防备通道：noBan 标记者永不被拉黑、永远缀在队尾（隐藏），
   * 只有普通通道全部失效/阵亡时才会被派上场——这是最后的保险。 */
  const guards = orderedChannels(pool.filter(c => !!c.noBan));
  let normal = orderedChannels(pool.filter(c => !c.noBan && !pxIsBanned(c.label)));
  if (!normal.length && !guards.length) normal = orderedChannels(pool.filter(c => !c.noBan)); /* 无防备时的兜底解禁 */
  const list = normal.concat(guards);
  if (!list.length) throw new Error('没有可用通道');
  const errs = [];
  const failed = [];       /* 无成功时的延迟判罚记录 {label, noBan, httpish} */
  let sawSuccess = false;
  return await new Promise((resolve, reject) => {
    let next = 0, inFlight = 0, done = false;
    const finish = (v) => { if (!done) { done = true; sawSuccess = true; resolve(v); } };
    const failIfDrained = () => {
      if (done || next < list.length || inFlight !== 0) return;
      done = true;
      /* 判罚规则：
       * · 混合轮（有通道成功/有通道拿到了 HTTP 状态码）→ 失败者记 strike（通道之罪）
       * · 纯传输层全灭（无一拿到响应）→ 本机网络断/被墙，不记 strike（防雪崩拉黑全队） */
      const anyHttp = failed.some(f => f.httpish);
      if (sawSuccess || anyHttp) failed.forEach(f => { if (!f.noBan) pxMarkFail(f.label); });
      if (!sawSuccess) {
        const blackout = !anyHttp;
        reject(new Error('全部通道失败（' + errs.slice(0, 3).join('；') + '）'
          + (blackout ? '。像是本机连不上解析中转：点下方【重置通道】再试，或切换 Wi-Fi/流量、开关 VPN' : '')));
      }
    };
    const launch = () => {
      if (done) return;
      while (inFlight < cap && next < list.length) {
        const c = list[next++];
        inFlight++;
        (async () => {
          const t0 = performance.now();
          try {
            let resp;
            if (c.wrap) resp = await withTimeout(c.wrap(url), ms, c.label + ' 超时');
            else resp = await withTimeout(fetch(c.mk(url)), ms, c.label + ' 超时');
            if (!resp || !resp.ok) throw new Error(c.label + ' HTTP ' + (resp ? resp.status : '网络错误'));
            recordRTT(c.label, performance.now() - t0);
            pxMarkOk(c.label);
            finish({ c, resp });
          } catch (e) {
            const raw = String((e && e.message) || e);
            const msg = raw.indexOf(c.label) === 0 ? raw : c.label + '：' + raw;
            const httpish = /HTTP \d{3}/.test(raw);
            if (sawSuccess) { if (!c.noBan) pxMarkFail(c.label); }
            else failed.push({ label: c.label, noBan: !!c.noBan, httpish });
            if (!c.noBan) pxPenalize(c.label);
            errs.push(msg);
          } finally {
            inFlight--;
            if (!done) launch();
            failIfDrained();
          }
        })();
      }
      failIfDrained();
    };
    launch();
  });
}

async function fetchTextSmart(url, opt) {
  opt = opt || {};
  if (opt.ms == null) opt.ms = 22000;
  /* 直连优先：CORS 开放的解析 API（tikwm / douyin.wtf / oioweb 等）一步命中，
   * 响应过不来（无 ACAO / 被墙）会立刻抛错，通常 <300ms，随后转代理竞速 */
  try {
    const t0 = performance.now();
    const rd = await withTimeout(fetch(url), 2600, '直连超时');
    if (rd && rd.ok) {
      const td = await rd.text();
      if (td) { recordRTT('直连', performance.now() - t0); pxMarkOk('直连'); return td; }
    }
  } catch (e) { /* 直连不通 → 立刻走代理 */ }
  const { resp } = await raceFetch(PROXY_TEXT, url, { ms: opt.ms, wave: 2 });
  const t = await resp.text();
  if (!t) throw new Error('通道返回了空内容');
  return t;
}

async function fetchJSONSmart(url, opt) {
  const text = await fetchTextSmart(url, opt);
  try { return JSON.parse(text); }
  catch (e) { throw new Error('接口返回的不是有效 JSON'); }
}

async function fetchBlobSmart(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 120000;
  const asBlob = async (resp) => {
    const b = await resp.blob();
    if (b.size > 0 && !/^\s*(text\/html|application\/json)/i.test(b.type || '')) return b;
    throw new Error('返回内容不是媒体文件');
  };
  /* 直连优先：B站/小红书/部分CDN 其实允许跨域直接读 */
  try {
    const resp = await withTimeout(fetch(url), Math.min(ms, 30000), '直连超时');
    return await asBlob(resp);
  } catch (e) { pxPenalize('直连', 3e5); }
  /* 走代理并发竞速；raceFetch 只挑 到指定的通道 */
  for (let round = 0; round < 2; round++) {
    try {
      const picked = PROXY_TEXT.filter(p => p.bin && !p.textOnly);
      const { resp } = await raceFetch(picked, url, { ms, wave: 2, binary: true });
      const b = await asBlob(resp);
      return b;
    } catch (e) { await sleep(round ? 1500 : 300); }
  }
  return null;
}

async function downloadViaBlob(url, filename) {
  const blob = await fetchBlobSmart(url);
  if (!blob) return false;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'file';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 40000);
  return true;
}

async function downloadSmart(url, filename) {
  toast('↓️ 开始下载…');
  try {
    const ok = await downloadViaBlob(url, filename);
    if (ok) { toast('已开始保存', 'ok'); return true; }
  } catch (e) { /* 继续兜底 */ }
  window.open(url, '_blank', 'noopener');
  toast(isIOS
    ? '未自动保存？在打开的页面长按视频/图片 → 存储到手机'
    : '未自动保存？在打开的页面长按或右键另存为', 'warn');
  return false;
}

/* ---------------- 链接提取/短链 ---------------- */
function extractURL(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>（）()【】，。]+/g);
  if (!m) return '';
  let u = m[0];
  u = u.replace(/[），。、！？！?…．»,]+$/g, '');
  u = u.replace(/[),.;!?]+$/g, '');
  return u;
}

async function resolveRedirect(url) {
  /* 短链还原只给 6 秒：快速失败不致命，
   * 后续解析会经代理直接抓短链页面（服务端跳转后返回真实内容）。 */
  try {
    const r = await withTimeout(fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url)), 6000);
    if (r.ok) {
      const j = await r.json();
      if (j && j.status && j.status.url) return j.status.url;
    }
  } catch (e) { /* 忽略，走原链接继续解析 */ }
  return url;
}

/* ---------------- 编码/杂项 ---------------- */
function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
function utf8ToB64(str) {
  return bytesToB64(new TextEncoder().encode(str));
}
function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i > 0 && n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function fileTitle(name) {
  return String(name).replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim();
}

function sanitizeName(n) {
  n = String(n).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  if (n.length > 80) n = n.slice(0, 80);
  return n || 'file';
}

/* 把返回的 JSON 字符串里可能出现的裸 undefined/NaN 修掉再 parse */
function cleanJson(s) {
  return s.replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, 'null');
}

/* ---------------- 弹窗 ---------------- */
function openModal(id) { $id(id).classList.remove('hidden'); }
function closeModal(id) { $id(id).classList.add('hidden'); }
