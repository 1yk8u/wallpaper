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

/* ---------------- CORS 代理通道 ---------------- */
const TEXT_PROXIES = [
  { label: 'allorigins', mk: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { label: 'codetabs',   mk: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
];
/* 支持 POST 转发的通道（快手主页批量用） */
const POST_PROXIES = [
  { label: 'corsworkers', mk: u => 'https://test.cors.workers.dev/?' + u },
  { label: 'corslol',     mk: u => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
];

async function fetchTextSmart(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 18000;
  const errs = [];
  try {
    const r = await withTimeout(fetch(url), ms);
    if (r.ok) { const t = await r.text(); if (t) return t; }
    errs.push('直连 HTTP ' + r.status);
  } catch (e) { errs.push('直连: ' + (e.message || e)); }
  for (const p of TEXT_PROXIES) {
    try {
      const r = await withTimeout(fetch(p.mk(url)), ms);
      if (r.ok) { const t = await r.text(); if (t && t.length) return t; }
      errs.push(p.label + ' HTTP ' + r.status);
    } catch (e) { errs.push(p.label + ': ' + (e.message || e)); }
  }
  throw new Error('所有通道均失败（' + errs.slice(0, 3).join('；') + '）');
}

async function fetchJSONSmart(url, opt) {
  const text = await fetchTextSmart(url, opt);
  try { return JSON.parse(text); }
  catch (e) { throw new Error('接口返回的不是有效 JSON'); }
}

async function fetchBlobSmart(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 120000;
  const attempt = async (r) => {
    if (!r.ok) return null;
    const b = await r.blob();
    if (b.size > 0 && !/text\/html/i.test(b.type)) return b;
    return null;
  };
  try {
    const b = await attempt(await withTimeout(fetch(url), ms));
    if (b) return b;
  } catch (e) { /* 忽略，走代理 */ }
  for (const p of TEXT_PROXIES) {
    try {
      const b = attempt(await withTimeout(fetch(p.mk(url)), ms));
      const res = await b;
      if (res) return res;
    } catch (e) { /* 下一个 */ }
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
  toast('⬇️ 开始下载…');
  try {
    const ok = await downloadViaBlob(url, filename);
    if (ok) { toast('✅ 已开始保存', 'ok'); return true; }
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
  try {
    const r = await withTimeout(fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url)), 20000);
    if (r.ok) {
      const j = await r.json();
      if (j && j.status && j.status.url) return j.status.url;
    }
  } catch (e) { /* 忽略 */ }
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
