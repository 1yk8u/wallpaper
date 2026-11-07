'use strict';
/* =====================================================================
 * parser/engine.mjs —— 壁纸库「自研解析引擎」核心（零依赖，Node 18+）
 *
 * 设计原则：
 *   1. 不调用任何第三方「解析 API」（tikwm / douyin.wtf / oioweb 之类一律不用）。
 *   2. 只请求平台自己的公开页面 / 官方公开接口，解析逻辑全部在本文件里实现。
 *   3. 页面内嵌 JSON 用「括号配平扫描」提取，不用贪婪正则，嵌套再深也不会截断。
 *   4. 统一输出结构，前端 / CLI / Actions 三处共用同一份结果。
 *
 * 可在浏览器之外运行：node parser/engine.mjs 不会执行任何操作（仅导出）。
 * ===================================================================== */

import { createHash } from 'node:crypto';

export const ENGINE_VERSION = '1.0.0';

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/* ------------------------------------------------------------------ *
 * 错误分类：前端会按 code 给出不同的中文提示
 * ------------------------------------------------------------------ */
export class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}
const fail = (code, msg) => { throw new ParseError(code, msg); };

/* ------------------------------------------------------------------ *
 * 链接识别 / 归一化
 * ------------------------------------------------------------------ */
export const PLATFORMS = {
  douyin:      { name: '抖音',     test: /douyin\.com|iesdouyin\.com|amemv\.com/i,           short: /v\.douyin\.com/i },
  kuaishou:    { name: '快手',     test: /kuaishou\.com|chenzhongtech\.com|kuaishouapp\.com/i, short: /v\.kuaishou\.com|v\.m\.chenzhongtech\.com/i },
  bilibili:    { name: '哔哩哔哩', test: /bilibili\.com|b23\.tv/i,                            short: /b23\.tv/i },
  xiaohongshu: { name: '小红书',   test: /xiaohongshu\.com|xhslink\.com/i,                    short: /xhslink\.com/i },
};

export function extractURL(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>（）()【】，。]+/g);
  if (!m) return '';
  return m[0].replace(/[），。、！？…．»,;!?.)]+$/g, '');
}

export function detectPlatform(raw) {
  const u = String(raw || '');
  for (const key of Object.keys(PLATFORMS)) {
    if (PLATFORMS[key].test.test(u)) return { key, ...PLATFORMS[key] };
  }
  return { key: 'generic', name: '通用直链' };
}

/** 与前端 ksCacheKey、旧缓存文件里的 key 完全同构，保证老缓存继续命中 */
export function normalizeKey(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?&#]/)[0]
    .replace(/\/+$/, '');
}

/** 轻量结果文件名：key 的 sha256 前 16 位，避免中文/特殊字符做文件名 */
export function resultKey(u) {
  return createHash('sha256').update(normalizeKey(u)).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * HTTP：自己跟 302、自己设 UA，不经过任何代理
 * ------------------------------------------------------------------ */
let COOKIE = '';
/** 本地 CLI 可注入自己的登录 cookie（只留在本机，不进仓库、不上传） */
export function setCookie(s) { COOKIE = String(s || '').trim(); }

function baseHeaders(mobile, extra) {
  return {
    ...(COOKIE ? { cookie: COOKIE } : {}),
    'user-agent': mobile ? UA_MOBILE : UA_DESKTOP,
    'accept': mobile
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    'cache-control': 'no-cache',
    ...(extra || {}),
  };
}

export async function httpGet(url, opt = {}) {
  const ms = opt.timeout || 25000;
  try {
    return await fetch(url, {
      method: opt.method || 'GET',
      body: opt.body,
      redirect: opt.redirect || 'follow',
      headers: baseHeaders(opt.mobile, opt.headers),
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    fail('NETWORK', '请求失败：' + (e.message || e) + '（' + url.slice(0, 90) + '）');
  }
}

/** 短链还原：逐跳读 Location，最多 6 跳（fetch follow 拿不到中间链，这里自己走） */
export async function resolveShort(raw) {
  let u = String(raw || '').trim();
  /* 媒体直链不用还原，更不能去 GET 整个视频文件 */
  if (/\.(mp4|m4v|mov|webm|jpe?g|png|webp|gif)(\?|#|$)/i.test(u)) return u;
  for (let i = 0; i < 6; i++) {
    const plat = detectPlatform(u);
    const isShort = /^https?:\/\/(v\.douyin|v\.kuaishou|b23\.tv|xhslink|v\.m\.chenzhongtech)/i.test(u);
    if (!isShort && plat.key !== 'generic') break;
    let r;
    try {
      r = await httpGet(u, { redirect: 'manual', timeout: 15000, mobile: true });
    } catch (e) { break; }
    if (![301, 302, 303, 307, 308].includes(r.status)) {
      /* 有些短链靠 JS 跳转，从 HTML 里找 canonical / 替换跳转 */
      if (r.status === 200) {
        let html = '';
        try { html = await r.text(); } catch (e) { /* ignore */ }
        const jump = html.match(/(?:location\.href|url)\s*=\s*["'](https?:\/\/[^"']+)["']/i) ||
                     html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i);
        if (jump && jump[1] && !/^https?:\/\//i.test(jump[1])) u = new URL(jump[1], u).href;
        else if (jump) u = decodeHTMLEntities(jump[1]);
        else break;
        continue;
      }
      break;
    }
    const loc = r.headers.get('location');
    if (!loc) break;
    try { u = new URL(loc, u).href; } catch (e) { break; }
  }
  return u;
}

/* ------------------------------------------------------------------ *
 * HTML / JSON 工具（自研部分）
 * ------------------------------------------------------------------ */
export function decodeHTMLEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x2f;/gi, '/').replace(/&#0?47;/gi, '/')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** JSON 里常见的 \u002F / \/ / \u003C 还原 */
export function unescapeJson(s) {
  return String(s == null ? '' : s)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

/**
 * 括号配平扫描：从 startIdx 处的 '{' 或 '[' 开始，跳过字符串里的括号，
 * 返回与它配对的结束位置。页面内嵌 JSON 动辄几十 KB 且层层嵌套，
 * 正则 /\{[\s\S]*?\}/ 会在第一个右括号截断，这里不会。
 */
function balancedEnd(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function safeParse(src) {
  try {
    return JSON.parse(String(src).replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, 'null'));
  } catch (e) { return null; }
}

/** 把页面里所有内嵌状态 JSON 抠出来：window.XXX = {...} / RENDER_DATA / JSON-LD / script json */
export function extractStates(html) {
  const out = [];
  const push = (name, data) => { if (data && typeof data === 'object') out.push({ name, data }); };

  /* 1) window.__APOLLO_STATE__ / _ROUTER_DATA / __INITIAL_STATE__ / __NUXT__ ... */
  const re = /(?:window|self)\.([_A-Za-z][\w]*)\s*=\s*(?=[\{\[])/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const s = re.lastIndex;
    const e = balancedEnd(html, s);
    if (e < 0) continue;
    const data = safeParse(html.slice(s, e));
    if (data) push(m[1], data);
    re.lastIndex = Math.min(e, html.length);
  }

  /* 2) 抖音 RENDER_DATA：URL 编码过的 JSON */
  const rd = html.match(/<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i);
  if (rd) {
    let raw = rd[1].trim();
    try { raw = decodeURIComponent(raw); } catch (e) { /* 本来就是明文 */ }
    push('RENDER_DATA', safeParse(raw));
  }

  /* 3) <script type="application/json"> 与 JSON-LD */
  const sr = /<script[^>]+type=["'](?:application\/(?:json|ld\+json))["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = sr.exec(html)) !== null) push('script-json', safeParse(m[1].trim()));

  /* 4) 兜底：整页找最大的一块 {...}（常见 SSR 没有变量名） */
  if (!out.length) {
    const idx = html.indexOf('{"');
    if (idx >= 0) {
      const e = balancedEnd(html, idx);
      if (e > idx) push('inline', safeParse(html.slice(idx, e)));
    }
  }
  return out;
}

/** 深度遍历对象，visit(key, value, depth) */
export function walk(node, visit, depth = 0) {
  if (node == null || depth > 9) return;
  if (Array.isArray(node)) {
    /* 数组里的字符串必须直接 visit：抖音 url_list / 快手 coverUrls 都是字符串数组 */
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') visit(String(i), v, depth);
      else walk(v, visit, depth + 1);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string') visit(k, v, depth);
      else walk(v, visit, depth + 1);
    }
  }
}

export function metaTags(html) {
  const pick = (prop) => {
    const r1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)["\']', 'i');
    const r2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i');
    const m = html.match(r1) || html.match(r2);
    return m ? decodeHTMLEntities(m[1]).trim() : '';
  };
  return {
    title: pick('og:title') || pick('twitter:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim(),
    image: pick('og:image') || pick('twitter:image'),
    video: pick('og:video') || pick('og:video:url') || pick('twitter:player:stream'),
    desc: pick('description') || pick('og:description'),
  };
}

const BAD_URL = /avatar|logo|icon|sprite|placeholder|qrcode|emoji|default_cover|loading|blank\.(gif|png)|favicon/i;
const IMG_EXT = /\.(jpe?g|png|webp|gif|heic|avif)(\?|#|$)/i;
const VID_EXT = /\.(mp4|m4v|mov|webm)(\?|#|$)/i;

function cleanURL(u) {
  let s = unescapeJson(decodeHTMLEntities(String(u || '').trim()));
  if (/^\/\//.test(s)) s = 'https:' + s;
  if (!/^https?:\/\//i.test(s)) return '';
  s = s.replace(/\\\//g, '/');
  if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
  if (BAD_URL.test(s)) return '';
  return s;
}

/** 从任意对象里挑出媒体直链；按 pathname 去重（同一张图的多个 CDN 域名只留一个） */
export function collectMedia(node, opt = {}) {
  const images = [], videos = [];
  const seenImg = new Set(), seenVid = new Set();
  const hostRe = opt.host ? new RegExp(opt.host, 'i') : null;
  walk(node, (k, v) => {
    const s = cleanURL(v);
    if (!s) return;
    const pathOK = IMG_EXT.test(s) || VID_EXT.test(s) || /\/(?:image|img|photo|video|tos|obj|bd|sns|aweme)/i.test(s);
    const hostOK = !hostRe || hostRe.test(s);
    if (!hostOK || !pathOK) return;
    let pname = s;
    try { pname = new URL(s).pathname; } catch (e) { /* keep raw */ }
    if (VID_EXT.test(s) || /video|play_addr|mainmv|durl/i.test(k)) {
      if (!seenVid.has(pname)) { seenVid.add(pname); videos.push(s); }
    } else if (IMG_EXT.test(s) || /image|cover|img|photo|atlas/i.test(k)) {
      if (!seenImg.has(pname)) { seenImg.add(pname); images.push(s); }
    }
  });
  return { images, videos };
}

/** 从整段 HTML 里兜底扫直链（含被转义过的 \u002F） */
function scanRawURLs(html, hostRe) {
  const text = unescapeJson(html);
  const all = text.match(/https?:\\?\/\\?\/[^\s"'<>\\)}\]]+/g) || [];
  const out = [];
  const seen = new Set();
  for (const raw of all) {
    const s = cleanURL(raw.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/[,;，。、'"`]+$/, ''));
    if (!s || seen.has(s)) continue;
    if (hostRe && !hostRe.test(s)) continue;
    if (!IMG_EXT.test(s) && !VID_EXT.test(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 判定是否风控 / 登录墙页 */
function guardPage(html, status) {
  if (status === 403 || status === 429) fail('RISK', '平台返回 HTTP ' + status + '（触发风控或限流）');
  const head = html.slice(0, 6000);
  if (/请输入验证码|安全验证|securityCheck|访问验证|滑块验证|captcha/i.test(head))
    fail('RISK', '平台弹了验证码页（海外服务器常见），建议用本地 CLI 在自己网络里解析');
  if (/请先登录|登录后查看|需要登录|login required/i.test(head) && html.length < 20000)
    fail('LOGIN', '该内容需要登录才能查看');
}

function firstURL(arr) {
  if (!Array.isArray(arr)) return '';
  for (const x of arr) {
    if (typeof x === 'string' && /^https?:/.test(cleanURL(x))) return cleanURL(x);
    if (x && typeof x === 'object') {
      const u = x.url || x.url_list?.[0] || x.src || x.urlDefault;
      if (u) return cleanURL(u);
    }
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 平台适配器：全部自己写
 * ------------------------------------------------------------------ */
async function getHTML(url, opt = {}) {
  const r = await httpGet(url, { mobile: opt.mobile !== false, timeout: opt.timeout || 25000, headers: opt.headers });
  let html = '';
  try { html = await r.text(); } catch (e) { /* ignore */ }
  guardPage(html, r.status);
  return { html, url: r.url || url, status: r.status };
}

/* ---- 抖音：分享页 _ROUTER_DATA / RENDER_DATA / 通用深扫 ---- */
async function parseDouyin(url, ctx) {
  const id = (url.match(/\/(?:video|note|slide)\/(\d{8,})/) || url.match(/modal_id=(\d{8,})/) || [])[1] || '';
  const targets = [];
  if (id) {
    targets.push('https://www.iesdouyin.com/share/video/' + id + '/');
    targets.push('https://www.iesdouyin.com/share/note/' + id + '/');
  }
  targets.push(url);
  let lastHTML = '', lastMeta = null;
  for (const t of targets) {
    let page;
    try { page = await getHTML(t, { mobile: true, headers: { referer: 'https://www.douyin.com/' } }); }
    catch (e) { if (e.code === 'RISK' || e.code === 'LOGIN') throw e; continue; }
    lastHTML = page.html;
    const meta = metaTags(lastHTML);
    if (meta.title) lastMeta = meta;
    const states = extractStates(lastHTML);
    for (const st of states) {
      /* 找带 images / play_addr 的作品对象 */
      let item = null;
      const findItem = (node, depth = 0) => {
        if (item || !node || depth > 9) return;
        if (Array.isArray(node)) { for (const n of node) findItem(n, depth + 1); return; }
        if (typeof node !== 'object') return;
        if ((Array.isArray(node.images) && node.images.length) ||
            (node.video && (node.video.play_addr || node.video.bit_rate_list)) ||
            (Array.isArray(node.url_list) && node.url_list.length && /\.(mp4|m3u8)/i.test(String(node.url_list[0])))) {
          item = node; return;
        }
        for (const k of Object.keys(node)) findItem(node[k], depth + 1);
      };
      findItem(st.data);
      const media = collectMedia(st.data, { host: 'douyinpic|byteimg|aweme|snssdk|douyinvod|ixigua|pstatp|toutiao' });
      const imgs = item && Array.isArray(item.images)
        ? item.images.map(x => firstURL([x]) || firstURL(x && x.url_list)).filter(Boolean)
        : [];
      const allImgs = [...new Set([...imgs, ...media.images])].slice(0, 30);
      let play = '';
      if (item && item.video) {
        play = firstURL([item.video.play_addr, ...(item.video.bit_rate_list || []).map(b => b.play_addr)]);
      }
      if (!play) play = media.videos[0] || '';
      const title = (item && (item.desc || item.title)) || meta.title || '抖音作品';
      const cover = firstURL([item?.video?.cover, item?.video?.origin_cover]) || meta.image || allImgs[0] || '';
      if (allImgs.length > 1 || (allImgs.length === 1 && !play)) {
        return { kind: 'images', images: allImgs.length ? allImgs : [meta.image].filter(Boolean), play: '', cover, title, via: st.name };
      }
      if (play) return { kind: 'video', images: [], play, cover, title, via: st.name };
    }
    /* 内嵌 JSON 没命中 → 直接扫 HTML 里的 CDN 直链 */
    const raw = scanRawURLs(lastHTML, /douyinpic|byteimg|aweme|snssdk|douyinvod|ixigua|pstatp/i);
    const imgs = raw.filter(u => IMG_EXT.test(u) || /image|photo/i.test(u));
    const vids = raw.filter(u => VID_EXT.test(u));
    if (imgs.length > 1 || (imgs.length && !vids.length)) {
      return { kind: 'images', images: imgs.slice(0, 30), play: '', cover: meta.image || imgs[0], title: meta.title || '抖音图集', via: 'html-scan' };
    }
    if (vids.length) return { kind: 'video', images: [], play: vids[0], cover: meta.image || '', title: meta.title || '抖音视频', via: 'html-scan' };
    if (meta.video) return { kind: 'video', images: [], play: meta.video, cover: meta.image, title: meta.title || '抖音视频', via: 'og-meta' };
    if (meta.image) return { kind: 'images', images: [meta.image], play: '', cover: meta.image, title: meta.title || '抖音作品', via: 'og-meta' };
  }
  fail(lastHTML.length < 2000 ? 'NETWORK' : 'STRUCT',
    '抖音页面拿到了（' + lastHTML.length + ' 字节）但没有可用直链' + (id ? '' : '，且没识别出作品 ID，请粘贴完整分享链接'));
}

/* ---- 快手：APOLLO_STATE / INITIAL_STATE / atlas / GraphQL ---- */
async function parseKuaishou(url, ctx) {
  /* 手机 UA 和桌面 UA 各试一次：两类页面内嵌数据形态不同，有的风控只弹其中一种 */
  const tries = [
    { mobile: true,  headers: { referer: 'https://www.kuaishou.com/', accept: 'text/html,application/xhtml+xml' } },
    { mobile: false, headers: { referer: 'https://www.kuaishou.com/', accept: 'text/html,application/xhtml+xml' } },
  ];
  let page = null, lastErr = '';
  for (const t of tries) {
    try {
      const p = await getHTML(url, t);
      /* 页面里带作品数据（photoId/mainMvUrls/mp4）才算有效，否则换下一种 UA 再试 */
      if (p && p.html && /photoId|photo_id|mainMvUrls|coverUrls|"photoUrl"|og:video|\.mp4|kphoto/i.test(p.html)) { page = p; break; }
      if (p && p.html && !page) page = p;   /* 先留着，万一两种都没货用它报错 */
    } catch (e) { lastErr = String(e.message || e); }
  }
  if (!page) fail('RISK', '快手页面拉取失败（' + (lastErr || '网络异常') + '），稍后重试或换完整作品链接');
  if (!/photoId|photo_id|mainMvUrls|coverUrls|"photoUrl"|og:video|\.mp4|kphoto/i.test(page.html)) {
    const risk = /环境异常|访问过于频繁|验证码|安全验证|扫码登录|二维码|请登录|login/i.test(page.html);
    fail('RISK', risk
      ? '快手弹了风控/登录页（服务器 IP 被拦）。手机上请用电脑跑 node parser/serve.mjs 后在高级设置里连本地引擎；电脑上直接用 node parser/cli.mjs 最稳'
      : '快手页面没有作品数据（可能是推荐页/风控页/短链已失效），换完整作品链接或在本地 CLI 里试');
  }
  const meta = metaTags(page.html);
  const states = extractStates(page.html);
  const items = [];
  for (const st of states) {
    const findPhotos = (node, depth = 0) => {
      if (!node || depth > 9 || items.length > 40) return;
      if (Array.isArray(node)) { for (const n of node) findPhotos(n, depth + 1); return; }
      if (typeof node !== 'object') return;
      if (node.photoId || node.photo_id || (Array.isArray(node.mainMvUrls)) || (Array.isArray(node.coverUrls) && Array.isArray(node.atlas?.list))) {
        items.push({ st: st.name, p: node });
      }
      for (const k of Object.keys(node)) findPhotos(node[k], depth + 1);
    };
    findPhotos(st.data);
  }
  /* 用 $ref 解引用（APOLLO_STATE 常态） */
  const deref = (v, all) => {
    if (v && typeof v === 'object' && v.$ref) {
      for (const st of states) {
        const found = st.data && st.data[v.$ref];
        if (found) return found;
      }
    }
    return v;
  };
  for (const { st, p0 } of items.map(x => ({ st: x.st, p0: x.p }))) {
    const p = deref(p0) || p0;
    const media = collectMedia(p, { host: 'yximgs|kuaishou|ksyun|chenzhongtech|kuaishouapp|ali2|a\.yximgs' });
    const atlas = (p.atlas && Array.isArray(p.atlas.list)) ? p.atlas.list : [];
    const atlasImgs = atlas.map(x => firstURL([x]) || cleanURL(String(x || ''))).filter(Boolean);
    const imgs = [...new Set([...atlasImgs, ...media.images])].slice(0, 30);
    let play = firstURL(p.mainMvUrls || []);
    const reps = [];
    const sets = (p.manifest && p.manifest.adaptationSet) || [];
    for (const s of sets) for (const r of (s.representation || [])) if (r && r.url) reps.push(r);
    reps.sort((a, b) => (b.width || 0) - (a.width || 0));
    if (!play && reps.length) play = cleanURL(reps.find(r => !/\.m3u8/i.test(r.url))?.url || reps[0].url);
    if (!play) play = media.videos[0] || '';
    const cover = firstURL(p.coverUrls || []) || media.images[0] || meta.image || '';
    const title = String(p.caption || p.title || meta.title || '快手作品').slice(0, 90);
    if (imgs.length && (!play || imgs.length > 1))
      return { kind: 'images', images: imgs, play: '', cover, title, via: st };
    if (play) return { kind: 'video', images: [], play, cover, title, via: st };
  }
  /* HTML 兜底：快手页面常把 mp4 直接塞进脚本串 */
  const raw = scanRawURLs(page.html, /yximgs|kuaishou|ksyun|chenzhongtech/i);
  const vids = raw.filter(u => VID_EXT.test(u));
  const imgs = raw.filter(u => IMG_EXT.test(u) || /image|photo/i.test(u));
  if (vids.length) return { kind: 'video', images: [], play: vids[0], cover: meta.image || imgs[0] || '', title: meta.title || '快手视频', via: 'html-scan' };
  if (imgs.length) return { kind: 'images', images: imgs.slice(0, 30), play: '', cover: imgs[0], title: meta.title || '快手图集', via: 'html-scan' };
  if (meta.video) return { kind: 'video', images: [], play: meta.video, cover: meta.image, title: meta.title || '快手视频', via: 'og-meta' };
  fail('STRUCT', '快手页面没有作品数据（可能是推荐页/风控页/短链已失效），换完整作品链接或在本地 CLI 里试');
}

/* B 站对无设备指纹的请求常返回 -412，先访问首页领一份 buvid3 cookie 再打 API */
async function biliCookie() {
  try {
    const r = await httpGet('https://www.bilibili.com/', { timeout: 12000 });
    const sc = r.headers.get('set-cookie') || '';
    const out = [];
    for (const n of ['buvid3', 'buvid4', 'b_nut', 'b_lsid', 'bili_ticket']) {
      const m = sc.match(new RegExp('(?:^|,\\s*|;\\s*)' + n + '=([^;,]+)'));
      if (m) out.push(n + '=' + m[1].trim());
    }
    return out.join('; ');
  } catch (e) { return ''; }
}

/* ---- B 站：官方公开接口，自己组装与解析 ---- */
async function parseBilibili(url) {
  const bv = (url.match(/BV[0-9A-Za-z]{10}/) || [])[0] || '';
  const aid = (url.match(/\/av(\d{4,})/i) || url.match(/[?&]aid=(\d+)/) || [])[1] || '';
  if (!bv && !aid) fail('STRUCT', '没识别出 BV 号 / av 号，请粘贴完整视频页链接');
  const H = {
    referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
  };
  const ck = await biliCookie();
  if (ck) H.cookie = ck;
  const vr = await httpGet('https://api.bilibili.com/x/web-interface/view?' + (bv ? 'bvid=' + bv : 'aid=' + aid),
    { headers: H, timeout: 20000 });
  let v = null;
  try { v = await vr.json(); } catch (e) { /* fallthrough */ }
  if (!v || v.code !== 0 || !v.data)
    fail('RISK', 'B 站接口返回 code ' + (v && v.code) + '（' + (v && v.message || '风控拦截') +
      '）。境外服务器 IP 常被拦，建议在自己电脑上用本地解析服务或 CLI');
  const d = v.data;
  const cid = d.cid;
  for (const qn of [80, 64, 32, 16]) {
    const pr = await httpGet('https://api.bilibili.com/x/player/playurl?bvid=' + (d.bvid || bv) +
      '&cid=' + cid + '&qn=' + qn + '&fnval=0&platform=html5&high_quality=1&otype=json',
      { headers: H, timeout: 20000 });
    let p = null;
    try { p = await pr.json(); } catch (e) { continue; }
    const durl = p && p.data && p.data.durl && p.data.durl[0];
    if (p && p.code === 0 && durl && durl.url) {
      return {
        kind: 'video', images: [], play: durl.url, cover: d.pic || '',
        title: d.title || 'B 站视频', size: durl.size || p.data?.size || 0,
        via: 'bilibili-official-api-qn' + qn,
      };
    }
  }
  fail('RISK', 'B 站 playurl 没给直链（可能是会员/区域限制），可先用网页端缓存观看');
}

/* ---- 小红书：__INITIAL_STATE__ / og meta / CDN 深扫 ---- */
async function parseXiaohongshu(url) {
  const page = await getHTML(url, { mobile: true, headers: { referer: 'https://www.xiaohongshu.com/' } });
  const meta = metaTags(page.html);
  for (const st of extractStates(page.html)) {
    let note = null;
    const findNote = (node, depth = 0) => {
      if (note || !node || depth > 9) return;
      if (Array.isArray(node)) { for (const n of node) findNote(n, depth + 1); return; }
      if (typeof node !== 'object') return;
      if ((Array.isArray(node.imageList) && node.imageList.length) || (node.video && node.video.media)) { note = node; return; }
      for (const k of Object.keys(node)) findNote(node[k], depth + 1);
    };
    findNote(st.data);
    if (!note) continue;
    const imgs = (note.imageList || []).map(im =>
      cleanURL(im.urlDefault || im.url || im.original ||
        (Array.isArray(im.infoList) && im.infoList.length ? im.infoList[im.infoList.length - 1].url : ''))
    ).filter(Boolean);
    const stream = note.video?.media?.stream || {};
    const cands = [].concat(stream.h264 || [], stream.h265 || [], stream.av1 || []);
    const play = cleanURL((cands.find(c => c && c.master_url && !/\.m3u8/i.test(c.master_url)) || cands[0] || {}).master_url || '');
    const title = note.title || note.displayTitle || note.desc || meta.title || '小红书笔记';
    if (play) return { kind: 'video', images: [], play, cover: imgs[0] || meta.image || '', title: String(title).slice(0, 90), via: st.name };
    if (imgs.length) return { kind: 'images', images: imgs.slice(0, 30), play: '', cover: imgs[0], title: String(title).slice(0, 90), via: st.name };
  }
  const raw = scanRawURLs(page.html, /xhscdn|xiaohongshu|sns-img|sns-webpic|ci\.xiaohongshu/i);
  const imgs = raw.filter(u => IMG_EXT.test(u) || /sns-img|sns-webpic|xhscdn/i.test(u));
  const vids = raw.filter(u => VID_EXT.test(u));
  if (vids.length) return { kind: 'video', images: [], play: vids[0], cover: meta.image || '', title: meta.title || '小红书视频', via: 'html-scan' };
  if (imgs.length) return { kind: 'images', images: imgs.slice(0, 30), play: '', cover: imgs[0], title: meta.title || '小红书笔记', via: 'html-scan' };
  if (meta.image) return { kind: 'images', images: [meta.image], play: '', cover: meta.image, title: meta.title || '小红书笔记', via: 'og-meta' };
  fail('LOGIN', '小红书页面没拿到笔记数据（多半需要登录 / 被风控），可在本地 CLI 里带 cookie 重试');
}

/* ---- 快手主页批量：先 SSR，再自己发 GraphQL ---- */
const KS_QUERY = 'query visionProfilePhotoList($pcursor:String,$userId:String,$page:String){visionProfilePhotoList(pcursor:$pcursor,userId:$userId,page:$page){result pcursor feeds{photo{id photoId caption mainMvUrls{url} coverUrls{url} atlas{list} manifest{adaptationSet{representation{width height url}}}}}}}';
async function parseKsProfile(url) {
  const uid = (url.match(/profile\/([A-Za-z0-9_-]{3,})/) || [])[1] || '';
  if (!uid) fail('STRUCT', '没识别出快手用户 ID，请粘贴完整主页链接 kuaishou.com/profile/xxx');
  const items = [], seen = new Set();
  const add = (p, via) => {
    if (!p || !p.photoId || seen.has(p.photoId)) return;
    seen.add(p.photoId);
    const media = collectMedia(p, { host: 'yximgs|kuaishou|ksyun|chenzhongtech' });
    const atlas = (p.atlas && Array.isArray(p.atlas.list)) ? p.atlas.list.map(x => firstURL([x])).filter(Boolean) : [];
    const reps = [];
    for (const s of (p.manifest?.adaptationSet || [])) for (const r of (s.representation || [])) if (r?.url) reps.push(r);
    reps.sort((a, b) => (b.width || 0) - (a.width || 0));
    const play = firstURL(p.mainMvUrls || []) || cleanURL(reps[0]?.url || '') || media.videos[0] || '';
    const imgs = [...new Set([...atlas, ...media.images])];
    const url2 = play || imgs[0] || '';
    if (!url2) return;
    items.push({
      photoId: String(p.photoId), title: String(p.caption || '快手作品').slice(0, 80),
      kind: play ? 'video' : 'image', url: url2,
      cover: firstURL(p.coverUrls || []) || imgs[0] || '', via,
    });
  };
  try {
    const page = await getHTML('https://www.kuaishou.com/profile/' + uid, { mobile: false });
    for (const st of extractStates(page.html)) {
      const scan = (node, depth = 0) => {
        if (!node || depth > 9) return;
        if (Array.isArray(node)) { for (const n of node) scan(n, depth + 1); return; }
        if (typeof node !== 'object') return;
        let v = node.$ref ? st.data[node.$ref] : null;
        if (v && v.photoId) add(v, st.name);
        if (node.photo && node.photo.photoId) add(node.photo, st.name);
        if (node.photoId) add(node, st.name);
        for (const k of Object.keys(node)) scan(node[k], depth + 1);
      };
      scan(st.data);
    }
  } catch (e) { /* GraphQL 继续 */ }

  let pcursor = '';
  for (let page = 0; page < 12 && items.length < 200; page++) {
    let r;
    try {
      r = await httpGet('https://www.kuaishou.com/graphql', {
        method: 'POST', timeout: 20000,
        headers: { 'content-type': 'application/json', referer: 'https://www.kuaishou.com/profile/' + uid, origin: 'https://www.kuaishou.com' },
        body: JSON.stringify({ operationName: 'visionProfilePhotoList', variables: { userId: uid, pcursor: String(pcursor), page: 'profile' }, query: KS_QUERY }),
      });
    } catch (e) { break; }
    let j = null;
    try { j = await r.json(); } catch (e) { break; }
    const d = j && j.data && j.data.visionProfilePhotoList;
    if (!d || !Array.isArray(d.feeds)) break;
    for (const f of d.feeds) if (f && f.photo) add(f.photo, 'graphql');
    if (!d.pcursor || d.pcursor === pcursor || d.pcursor === 'NO_MORE' || String(d.pcursor) === '0') break;
    pcursor = d.pcursor;
  }
  if (!items.length) fail('RISK', '主页没抓到作品（快手反爬 / 账号私密 / 需要 cookie），可先单个作品逐个解析');
  return { kind: 'profile', items: items.slice(0, 200), title: '快手主页 ' + uid, via: 'apollo+graphql' };
}

/* ---- 通用：直链 / 任意网页 ---- */
async function parseGeneric(url) {
  if (VID_EXT.test(url) || /\.(m3u8)(\?|#|$)/i.test(url))
    return { kind: 'video', images: [], play: url, cover: '', title: decodeURIComponent(url.split('/').pop().split('?')[0]) || '直链视频', via: 'direct' };
  if (IMG_EXT.test(url))
    return { kind: 'images', images: [url], play: '', cover: url, title: decodeURIComponent(url.split('/').pop().split('?')[0]) || '直链图片', via: 'direct' };
  const page = await getHTML(url, { mobile: false });
  const meta = metaTags(page.html);
  const raw = scanRawURLs(page.html, null);
  const imgs = raw.filter(u => IMG_EXT.test(u));
  const vids = raw.filter(u => VID_EXT.test(u));
  const states = extractStates(page.html);
  for (const st of states) {
    const m = collectMedia(st.data);
    imgs.push(...m.images); vids.push(...m.videos);
  }
  const images = [...new Set(imgs)].slice(0, 30);
  if (meta.image) images.unshift(meta.image);
  if (meta.video || vids.length)
    return { kind: 'video', images: [], play: meta.video || vids[0], cover: meta.image || '', title: meta.title || '网页视频', via: 'generic-scan' };
  if (images.length)
    return { kind: 'images', images: [...new Set(images)].slice(0, 30), play: '', cover: images[0], title: meta.title || '网页图集', via: 'generic-scan' };
  fail('EMPTY', '这个页面里没找到图片或视频直链');
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */
export async function parse(rawUrl, opt = {}) {
  const input = extractURL(rawUrl) || String(rawUrl || '').trim();
  if (!input) fail('STRUCT', '没有识别到链接');
  let plat = detectPlatform(input);
  let finalURL = input;
  if (!opt.noResolve) {
    try { finalURL = await resolveShort(input); } catch (e) { /* 用原链接继续 */ }
    const p2 = detectPlatform(finalURL);
    if (plat.key === 'generic' && p2.key !== 'generic') plat = p2;
  }
  if (opt.log) opt.log('平台=' + plat.name + '  还原后=' + finalURL.slice(0, 140));

  const isProfile = opt.profile || (plat.key === 'kuaishou' && /\/profile\//i.test(finalURL));
  let result;
  if (isProfile) result = await parseKsProfile(finalURL);
  else if (plat.key === 'douyin') result = await parseDouyin(finalURL, { input });
  else if (plat.key === 'kuaishou') result = await parseKuaishou(finalURL, { input });
  else if (plat.key === 'bilibili') result = await parseBilibili(finalURL);
  else if (plat.key === 'xiaohongshu') result = await parseXiaohongshu(finalURL);
  else result = await parseGeneric(finalURL);

  /* 输出统一清洗：去空、限制数量、标题去控制字符 */
  const title = String(result.title || plat.name + '内容').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  return {
    ...result,
    title,
    images: (result.images || []).filter(u => /^https?:\/\//i.test(u)).slice(0, 30),
    play: result.play || '',
    cover: result.cover || '',
    platform: plat.key,
    platformName: plat.name,
    key: normalizeKey(input),
    resultKey: resultKey(input),
    finalKey: normalizeKey(finalURL),
    sourceUrl: finalURL,
    engine: ENGINE_VERSION,
    ts: new Date().toISOString(),
  };
}

/** 批量解析，单条失败不影响其它条；返回 {key, ok, data|error} 数组 */
export async function parseMany(urls, opt = {}) {
  const out = [];
  for (const raw of urls) {
    const key = normalizeKey(extractURL(raw) || raw);
    if (!key) continue;
    try {
      const data = await parse(raw, opt);
      out.push({ key, ok: true, data });
      if (opt.onEach) opt.onEach(out[out.length - 1]);
    } catch (e) {
      const err = { key, ok: false, error: { code: e.code || 'UNKNOWN', message: String(e.message || e).slice(0, 200) } };
      out.push(err);
      if (opt.onEach) opt.onEach(err);
    }
  }
  return out;
}
