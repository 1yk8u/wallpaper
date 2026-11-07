/* =====================================================================
 * parse-queue.mjs —— 自家解析中转（GitHub Actions 代抓）
 * 由 .github/workflows/parse-queue.yml 触发；结果写入 data/parse-cache.json，
 * 与前端 kuaishouItemFromPhoto / prepareKey(ksCacheKey) 完全同构。
 * 输入：env.PARSE_URLS（换行/逗号分隔的链接）
 * ===================================================================== */
import fs from 'node:fs';

const CACHE_PATH = new URL('../data/parse-cache.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- 小工具 ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchT(url, opt = {}, ms = 30000) {
  return fetch(url, {
    ...opt,
    headers: { 'user-agent': UA, ...(opt.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
}
/* \u002F → / ，\uXXXX → 字符（与前端 unescapeJsonish 等价） */
const unesc = (s) => String(s || '')
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\\//g, '/');
const deepCollect = (node, testFn, out = [], depth = 0) => {
  if (!node || depth > 7) return out;
  if (Array.isArray(node)) { node.forEach(n => deepCollect(n, testFn, out, depth + 1)); return out; }
  if (typeof node === 'object') {
    for (const k in node) {
      const v = node[k];
      if (typeof v === 'string') { if (testFn(k, v)) out.push(v); }
      else deepCollect(v, testFn, out, depth + 1);
    }
  }
  return out;
};
const imgCands = (o) => deepCollect(o, (_, v) => /^https?:\/\//.test(v) && /\.(jpe?g|png|webp)(\?|#|$)/i.test(v))
  .map(unesc).filter(u => !/avatar|logo|icon/i.test(u));
const vidCands = (o) => {
  const l = deepCollect(o, (_, v) => /^https?:\/\//i.test(v) && /\.(mp4|m3u8)(\?|#|$)/i.test(v)).map(unesc);
  const mp4 = l.filter(u => /\.mp4/i.test(u));
  return mp4.length ? mp4 : l;
};
/* 与前端 ksCacheKey 逐字节一致 */
const cacheKey = (u) => String(u || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/^www\./, '')
  .split(/[?&#]/)[0]
  .replace(/\/+$/, '');

/* ---------- 各平台解析 ---------- */
async function resolveShort(url) {
  try {
    const r = await fetchT(url, { redirect: 'follow' }, 20000);
    return r.url || url;
  } catch (e) { return url; }
}

async function parseKuaishou(finalURL) {
  /* SSR APOLLO_STATE（与前端 ksProfileSSR 同构） */
  const html = await (await fetchT(finalURL, { headers: { accept: 'text/html,application/xhtml+xml' } }, 30000)).text();
  if (/请输入验证码|securityCheck|verify/i.test(html.slice(0, 3000))) throw new Error('快手风控页(需验证)');
  const m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})<\/script>/);
  if (!m) throw new Error('页面无 APOLLO_STATE(html长度' + html.length + ')');
  const st = JSON.parse(String(m[1]).replace(/undefined/g, 'null'));
  const items = [];
  for (const key in st) {
    let v = st[key];
    if (v && v.$ref) v = st[v.$ref] || null;
    if (!v || typeof v !== 'object') continue;
    if (!(v.photoId || v.id)) continue;
    const playMv = Array.isArray(v.mainMvUrls) && v.mainMvUrls[0]
      ? unesc(typeof v.mainMvUrls[0] === 'string' ? v.mainMvUrls[0] : (v.mainMvUrls[0].url || '')) : '';
    const cover = Array.isArray(v.coverUrls) && v.coverUrls[0]
      ? unesc(typeof v.coverUrls[0] === 'string' ? v.coverUrls[0] : (v.coverUrls[0].url || '')) : '';
    const caption = String(v.caption || '').slice(0, 80) || '快手作品';
    let imgs = imgCands(v);
    let kind, images = [], play = '', coverUse = cover;
    if (playMv && /\.(mp4|m3u8)/i.test(playMv)) { kind = 'video'; play = playMv; images = []; coverUse = cover || imgs[0] || ''; }
    else {
      images = [...new Set(imgs)].slice(0, 30);
      if (!images.length) continue;
      kind = 'images'; coverUse = cover || images[0];
    }
    items.push({ kind, images, play, title: caption, cover: coverUse });
  }
  if (!items.length) throw new Error('APOLLO_STATE 解析到 0 个作品');
  return items[0];
}

async function parseDouyin(finalURL) {
  try {
    const j = await (await fetchT('https://api.tikwm.com/api/?url=' + encodeURIComponent(finalURL) + '&hd=1', {}, 30000)).json();
    if (j && j.code === 0 && j.data) {
      const d = j.data;
      const imgs = (Array.isArray(d.images) ? d.images : []).map(x => typeof x === 'string' ? x : (x && x.url)).filter(Boolean);
      let play = String(d.play || d.wmplay || '');
      if (play.startsWith('/')) play = 'https://www.tikwm.com' + play;
      if (imgs.length) return { kind: 'images', images: imgs.slice(0, 30), title: d.title || '抖音图集', cover: d.cover || imgs[0] };
      if (play) return { kind: 'video', play, title: d.title || '抖音视频', cover: d.cover || '' };
    }
  } catch (e) { /* 走 douyin.wtf */ }
  try {
    const j = await (await fetchT('https://api.douyin.wtf/api/hybrid/video_data?url=' + encodeURIComponent(finalURL), {}, 30000)).json();
    const data = (j && (j.aweme_detail || j.data)) || j;
    const item = (data && (data.item_list ? data.item_list[0] : data)) || {};
    const imgs = imgCands(item).slice(0, 30);
    const vids = vidCands(item);
    const title = item.desc || item.title || '抖音内容';
    if (imgs.length) return { kind: 'images', images: imgs, title, cover: imgs[0] };
    if (vids.length) return { kind: 'video', play: vids[0], title, cover: imgs[0] || '' };
  } catch (e) { /* 再败则失败 */ }
  throw new Error('tikwm 与 douyin.wtf 均未取到内容');
}

async function parseBilibili(finalURL) {
  const bv = (finalURL.match(/BV([0-9A-Za-z]{9,11})/) || [])[1];
  const aid = (finalURL.match(/av(\d{6,})/) || [])[1];
  const target = bv ? 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv
    : (aid ? 'https://api.bilibili.com/x/web-interface/view?aid=' + aid : null);
  if (!target) throw new Error('无法识别 BV/av 号');
  const H = { headers: { referer: 'https://www.bilibili.com/' } };
  const v = await (await fetchT(target, H, 30000)).json();
  if (!v || v.code !== 0 || !v.data) throw new Error('B站 view API 未取到(code ' + (v && v.code) + ')');
  const cid = v.data.cid, avid = v.data.aid;
  const p = await (await fetchT('https://api.bilibili.com/x/player/playurl?avid=' + avid + '&cid=' + cid + '&qn=64&type=&otype=json&platform=html5&high_quality=1', H, 30000)).json();
  const play = p && p.data && p.data.durl && p.data.durl[0] && p.data.durl[0].url;
  if (play) return { kind: 'video', play, title: v.data.title || 'B站视频', cover: v.data.pic || '' };
  throw new Error('B站 playurl 未取到播放地址');
}

async function parseXhs(finalURL, html) {
  const mHtml = html || (await (await fetchT(finalURL, { headers: { accept: 'text/html' } }, 30000)).text());
  const pick = (prop) => {
    const m = mHtml.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]+)"', 'i')) ||
              mHtml.match(new RegExp('<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="' + prop + '"', 'i'));
    return m ? m[1].replace(/&amp;/g, '&').trim() : '';
  };
  const title = pick('og:title') || '小红书';
  const image = pick('og:image');
  const images = [image, ...imgCands({}).length ? [] : []].filter(Boolean);
  const cands = [...new Set([...(image ? [image] : []), ...deepCollect(
    (() => { try { const s = mHtml.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})<\/script>/); return s ? JSON.parse(s[1].replace(/undefined/g, 'null')) : {}; } catch (e) { return {}; } })(),
    (_, v) => /^https?:\/\//.test(v) && /sns-img|sns-webpic|xhscdn/.test(v)
  ).map(unesc)])].filter(u => !/avatar|logo|icon/i.test(u)).slice(0, 30);
  if (!cands.length) throw new Error('小红书页面未取到图片(需登录/风控)');
  return { kind: 'images', images: cands, title, cover: cands[0] };
}

/* ---------- 主流程 ---------- */
const urls = String(process.env.PARSE_URLS || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
if (!urls.length) { console.log('PARSE_URLS 为空，无事可做'); process.exit(0); }

let cache = { updated: '', entries: {} };
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (e) {}
cache.entries = cache.entries || {};

let changed = 0;
for (const raw of urls) {
  const url = raw;
  const key = cacheKey(url);
  if (!key) continue;
  const prior = cache.entries[key];
  const hasGood = !!(prior && !prior.err);
  try {
    const finalURL = await resolveShort(url);
    console.log('RESOLVE ' + key + ' → ' + finalURL);
    const isKs = /kuaishou\.com|chenzhongtech/i.test(finalURL) || /kuaishou\.com|chenzhongtech/i.test(url);
    const isDouyin = /douyin\.com|iesdouyin\.com/i.test(finalURL);
    const isBili = /bilibili\.com|b23\.tv/i.test(finalURL);
    const isXhs = /xiaohongshu\.com|xhslink\.com/i.test(finalURL);
    let result = null;
    if (isKs) result = await parseKuaishou(finalURL).catch(e => { throw new Error('快手 SSR：' + (e.message || e)); });
    else if (isDouyin) result = await parseDouyin(finalURL);
    else if (isBili) result = await parseBilibili(finalURL);
    else if (isXhs) result = await parseXhs(finalURL);
    else { console.log('SKIP 不支持的平台：' + key); continue; }

    if (result) {
      cache.entries[key] = { ...result, ts: new Date().toISOString() };
      changed++;
      console.log('OK ' + key + ' → ' + result.kind + ' ×' + (result.images ? result.images.length : 1));
    } else if (hasGood) {
      console.log('KEEP ' + key + '（代抓没取到，但已有成功结果，不覆盖）');
    } else {
      cache.entries[key] = { err: '代抓未取到内容（页面结构变化或需登录）', ts: new Date().toISOString() };
      changed++;
      console.log('FAIL ' + key + '（写err，前端会给提示）');
    }
  } catch (e) {
    if (hasGood) console.log('ERR ' + key + '：' + (e.message || e) + '（保留已有成功结果）');
    else {
      cache.entries[key] = { err: String(e.message || e).slice(0, 120), ts: new Date().toISOString() };
      changed++;
      console.log('ERR ' + key + '：' + (e.message || e));
    }
  }
  await sleep(800); /* 温和节奏，别触发风控 */
}

cache.updated = new Date().toISOString();
if (changed) fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
console.log('新增/更新 ' + changed + ' 条 → data/parse-cache.json');
