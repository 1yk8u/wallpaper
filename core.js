'use strict';
/* =====================================================================
 * core.js —— 公共工具（画廊、解析、下载共用）
 *
 * 网络层原则（自研化）：只允许两种路——
 *   ① 本站直连（浏览器直接请求平台/CDN 自己的地址）
 *   ② 自家仓库中转（repository_dispatch → GitHub Actions 代抓）
 * 一切第三方 CORS 中转、代理通道、测速/拉黑体系已整体删除。
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

/* ---------------- 直连抓取（无任何第三方中转） ---------------- */
async function fetchTextSmart(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 20000;
  const r = await withTimeout(fetch(url, opt.init || {}), ms, '直连超时');
  if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '网络错误'));
  const t = await r.text();
  if (!t) throw new Error('返回了空内容');
  return t;
}

async function fetchJSONSmart(url, opt) {
  const text = await fetchTextSmart(url, opt);
  try { return JSON.parse(text); }
  catch (e) { throw new Error('接口返回的不是有效 JSON'); }
}

async function fetchBlobSmart(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 60000;
  try {
    const resp = await withTimeout(fetch(url), Math.min(ms, 30000), '直连超时');
    const b = await resp.blob();
    if (b.size > 0 && !/^\s*(text\/html|application\/json)/i.test(b.type || '')) return b;
    return null;
  } catch (e) { return null; }
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
  /* 付费配额检查 */
  if (typeof Payment !== 'undefined') {
    if (!Payment.canDownload()) {
      toast('今日下载额度已用完（' + Payment.getDailyLimit() + ' 张）', 'warn');
      Payment.showPaymentModal();
      return false;
    }
    Payment.consumeDownload();
    const rem = Payment.getRemaining();
    if (rem !== Infinity && rem <= 10 && rem > 0) {
      toast('今日剩余 ' + rem + ' 张', 'warn');
    }
    if (typeof Payment.updateQuotaDisplay === 'function') Payment.updateQuotaDisplay();
  }
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

/* ---------------- 链接提取 ----------------
 * 分享口令常见两种脏形态：
 *   ① 明文整段："风景… https://v.kuaishou.com/JVPUEMk2 复制此链接…"
 *   ② 整段被 URL 编码后拼上标题："https://v.kuaishou.com/JVPUEMk2%20%22%E9%A3%8E…"
 * 第 ② 种里百分号编码不含空白字符，旧正则会把标题一起吞进 URL ——
 * 派单给中转后请求 404，报「无法从链接提取快手作品号」。
 * 先安全解码还原明文，再提取纯链接；后端 parse-queue.mjs 的 sanitizeUrl 与此同构。
 * ------------------------------------------------------------------ */
function safePctDecode(s) {
  let t = String(s || '');
  /* 结尾常是残缺编码（如 "…%E5%"），decodeURIComponent 会抛 URIError；
   * 逐次砍掉末尾不完整的 %XX 再试，最坏只丢标题尾巴，不影响链接本身。 */
  for (let i = 0; i < 6; i++) {
    try { return decodeURIComponent(t); } catch (e) {
      const cut = t.replace(/%[0-9a-fA-F]{0,1}$/, '').replace(/%[0-9a-fA-F]{2}$/, '');
      if (cut === t) break;
      t = cut;
    }
  }
  return t;
}
function extractURL(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let src = raw;
  if (/%[0-9a-fA-F]{2}/i.test(raw)) {
    const dec = safePctDecode(raw);
    if (/https?:\/\//i.test(dec)) src = dec;
  }
  const m = src.match(/https?:\/\/[^\s"'<>（）()【】，。]+/g);
  if (!m) return '';
  let u = m[0];
  /* 兜底：解码未生效时，遇到编码的空白/引号/#/?/& 就视为链接结束 */
  u = u.split(/%(?:20|22|09|0a|0d|23|3f|26|3c|3e|27|28|29|2c|2e|3b|21)/i)[0];
  u = u.replace(/%[0-9a-fA-F]{0,1}$/i, '');
  u = u.replace(/[），。、！？！?…．»,]+$/g, '');
  u = u.replace(/[),.;!?]+$/g, '');
  return u;
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
