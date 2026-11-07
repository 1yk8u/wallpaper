'use strict';
/* =====================================================================
 * ownparse.js ── 浏览器端自研解析引擎（v1 · 2026-11-07）
 *
 * 原则：解析逻辑全部自己写 —— 自己抓分享页、自己用括号配平剥内嵌 JSON、
 *       自己深扫 CDN 直链。不调用任何第三方「解析 API」。
 * 页面若被 CORS 拦截，走通用网页中转（只搬运原始 HTML，不做任何解析）。
 *
 * 支持平台：抖音 / 快手 / 哔哩哔哩 / 小红书
 * 对外入口：ownBrowserParse(url, plat) → { kind, images|play, title, cover, via }
 * ===================================================================== */

/* ---------- 通用网页中转（fetch relay，仅代理原始内容） ---------- */
const OP_RELAYS = [
  { name: '直连',       mk: u => u },
  { name: 'allorigins', mk: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'codetabs',   mk: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
  { name: 'corsproxy',  mk: u => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
  { name: 'jina',       mk: u => 'https://r.jina.ai/' + u },
];

function opTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || '超时')), ms)),
  ]);
}

/** 所有中转并发竞速，第一个抓到的直接用（快几倍）；全失败抛汇总错误 */
async function opFetchPage(url, opt) {
  opt = opt || {};
  const ms = opt.ms || 10000;
  const attempts = OP_RELAYS.map(r => (async () => {
    const resp = await opTimeout(fetch(r.mk(url), { cache: 'no-store' }), ms, r.name + ' 超时');
    if (!resp.ok) throw new Error(r.name + ':HTTP' + resp.status);
    const text = await resp.text();
    if (!text || text.length < 500) throw new Error(r.name + ':内容过短');
    return { html: text, via: r.name };
  })());
  if (typeof Promise.any === 'function') {
    try { return await Promise.any(attempts); }
    catch (e) { /* 落到下面收集错误 */ }
  }
  const errors = [];
  for (const a of attempts) { try { errors.push((await a).via + ':OK'); } catch (x) { errors.push(x.message); } }
  throw new Error('页面获取失败（' + errors.slice(0, 3).join('；') + '）');
}

/* ---------- 核心：括号配平剥内嵌 JSON ---------- */
function opBalanced(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (!depth) return s.slice(start, i + 1); }
  }
  return '';
}

/** 找出页面里所有 window.__XXX__ = {...} 的内嵌状态对象 */
function opStates(html) {
  const out = [];
  const re = /window\.[\w$]+\s*=\s*/g;
  let m;
  while ((m = re.exec(html))) {
    const j = opBalanced(html, re.lastIndex);
    if (j && j.length > 60) {
      try { out.push(JSON.parse(j)); } catch (e) { /* 非 JSON，跳过 */ }
    }
  }
  return out;
}

/** 深度遍历，visit(key, value) 对每个键值调用（value 可能是任意类型） */
function opWalk(node, visit, depth) {
  depth = depth || 0;
  if (node == null || depth > 10) return;
  if (Array.isArray(node)) { for (const v of node) opWalk(v, visit, depth + 1); return; }
  if (typeof node === 'object') {
    for (const k in node) { visit(k, node[k], depth); opWalk(node[k], visit, depth + 1); }
  }
}

/* ---------- 字符串/URL 工具 ---------- */
function opUnescape(s) {
  return String(s)
    .replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
}
function opVideoURLs(text) {
  const all = String(text).match(/https?:\/\/[^\s"'<>\\)]+/g) || [];
  const skip = /avatar|logo|icon|\.svg|\.css|\.js(\?|$)/i;
  return [...new Set(all.filter(u => /\.mp4(\?|$)/i.test(opUnescape(u))))].map(opUnescape).filter(u => !skip.test(u));
}
function opImgURLs(text) {
  const all = String(text).match(/https?:\/\/[^\s"'<>\\)]+/g) || [];
  const skip = /avatar|logo|icon|sprite|\.svg|favicon/i;
  return [...new Set(all.filter(u => /\.(jpe?g|png|webp|heic)(\?|$)/i.test(opUnescape(u))))]
    .map(opUnescape).filter(u => !skip.test(u));
}
function opOg(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]+)"', 'i')) ||
            html.match(new RegExp('<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="' + prop + '"', 'i'));
  return m ? opUnescape(m[1]) : '';
}

/* ---------- 抖音：分享页 _ROUTER_DATA 自己剥 ---------- */
async function opDouyin(url) {
  const id = (url.match(/\/video\/(\d+)/) || url.match(/\/note\/(\d+)/) || url.match(/modal_id=(\d+)/) || [])[1];
  if (!id) return null;
  for (const kind of ['video', 'note']) {
    let page;
    try { page = await opFetchPage('https://www.iesdouyin.com/share/' + kind + '/' + id + '/'); }
    catch (e) { continue; }
    let item = null;
    for (const st of opStates(page.html)) {
      opWalk(st, (k, v) => {
        if (!item && v && typeof v === 'object' && !Array.isArray(v) &&
            ((Array.isArray(v.images) && v.images.length) ||
             (v.video && v.video.play_addr) || v.play_addr)) item = v;
      });
      if (item) break;
    }
    if (!item) continue;
    const via = '自研引擎·抖音/' + page.via;
    const title = (item.desc || '').slice(0, 100) || '抖音作品';
    /* 图集：images[].url_list */
    const imgs = [];
    if (Array.isArray(item.images)) {
      for (const im of item.images) {
        opWalk(im, (k, v) => {
          if (typeof v === 'string' && /^https?:\/\//.test(v) && !/avatar|logo|icon/i.test(v)) imgs.push(opUnescape(v));
        });
      }
    }
    const uniqImgs = [...new Set(imgs)].slice(0, 30);
    if (uniqImgs.length > 1) return { kind: 'images', images: uniqImgs, title, cover: uniqImgs[0], via };
    /* 视频：video.play_addr.uri → 自己拼播放地址 */
    const pa = (item.video && item.video.play_addr) || item.play_addr || null;
    if (pa) {
      let play = '';
      if (pa.uri) play = 'https://www.iesdouyin.com/aweme/v1/play/?video_id=' + pa.uri + '&ratio=1080p&line=0';
      else {
        const cand = (pa.url_list || []).map(opUnescape).find(u => /^https?:\/\//.test(u));
        if (cand) play = cand;
      }
      if (play) return { kind: 'video', play, title, cover: uniqImgs[0] || opOg(page.html, 'og:image'), via };
    }
    /* 兜底：整页扫 mp4 */
    const vids = opVideoURLs(page.html).filter(u => !/m3u8/i.test(u));
    if (vids.length) return { kind: 'video', play: vids[0], title, cover: opOg(page.html, 'og:image'), via };
  }
  return null;
}

/* ---------- 快手：整页 HTML 自己剥（中转会自动跟 302 短链） ---------- */
async function opKuaishou(url) {
  let page;
  try { page = await opFetchPage(url); } catch (e) { return null; }
  const html = opUnescape(page.html);
  const via = '自研引擎·快手/' + page.via;
  const title = ((html.match(/"caption"\s*:\s*"([^"]{1,120})"/) || [])[1] ||
                 opOg(page.html, 'og:title') ||
                 (html.match(/<title[^>]*>([^<]{1,120})</i) || [])[1] || '快手作品').trim();
  const cover = opOg(page.html, 'og:image');
  /* 1) og:video */
  const ogv = opOg(page.html, 'og:video') || opOg(page.html, 'og:video:url');
  if (ogv && /\.mp4/i.test(ogv)) return { kind: 'video', play: ogv, title, cover, via };
  /* 2) photoUrl / mainMvUrls / 整页 mp4 扫描 */
  const photoUrl = (html.match(/"photoUrl"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i) || [])[1];
  if (photoUrl) return { kind: 'video', play: photoUrl, title, cover, via };
  const vids = opVideoURLs(html).filter(u => !/m3u8/i.test(u));
  if (vids.length) return { kind: 'video', play: vids[0], title, cover, via };
  /* 3) 图集：整页图片扫描（排除登录横幅/表情包等 UI 图；单张必须是作品图路径才认） */
  const imgs = [...new Set(opImgURLs(html)
    .filter(u => /kuaishou|kwimgs|chenzhongtech|yximgs|itc\.cn/i.test(u))
    .filter(u => !/\/login|loginbanner|banner|\/pc\/|emotion|sticker|emoji|\/bs2\//i.test(u)))]
    .slice(0, 30);
  if (imgs.length >= 2 || (imgs.length === 1 && /kphoto|\/photo\//i.test(imgs[0])))
    return { kind: 'images', images: imgs, title, cover: imgs[0], via };
  return null;
}

/* ---------- 哔哩哔哩：公开接口自己调，CORS 不行就中转 ---------- */
async function opBili(url) {
  const bv = (url.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  const aid = (url.match(/\/video\/av(\d+)/i) || [])[1];
  if (!bv && !aid) return null;
  const getJSON = async (u) => {
    try {
      const r = await opTimeout(fetch(u, { cache: 'no-store' }), 10000, 'B站接口超时');
      if (r.ok) return await r.json();
    } catch (e) { /* 走中转 */ }
    const page = await opFetchPage(u, { ms: 12000 });
    return JSON.parse(page.html);
  };
  let view;
  try { view = await getJSON('https://api.bilibili.com/x/web-interface/view?' + (bv ? 'bvid=' + bv : 'aid=' + aid)); }
  catch (e) { return null; }
  if (!view || view.code !== 0 || !view.data) return null;
  const d = view.data;
  for (const qn of [64, 32, 16]) {
    try {
      const p = await getJSON('https://api.bilibili.com/x/player/playurl?bvid=' + d.bvid +
        '&cid=' + d.cid + '&qn=' + qn + '&platform=html5&high_quality=1&otype=json');
      if (p && p.code === 0 && p.data && Array.isArray(p.data.durl) && p.data.durl.length)
        return { kind: 'video', play: p.data.durl[0].url, title: d.title, cover: d.pic, via: '自研引擎·B站' };
    } catch (e) { /* 下一档清晰度 */ }
  }
  return null;
}

/* ---------- 小红书：__INITIAL_STATE__ 自己剥 ---------- */
async function opXhs(url) {
  let page;
  try { page = await opFetchPage(url); } catch (e) { return null; }
  const via = '自研引擎·小红书/' + page.via;
  const id = (url.match(/(?:explore|discovery\/item)\/([0-9a-f]{24})/i) || [])[1];
  const m = page.html.match(/window\.__INITIAL_STATE__\s*=\s*/);
  if (m) {
    const raw = opBalanced(page.html, m.index + m[0].length).replace(/:\s*undefined/g, ':null');
    try {
      const st = JSON.parse(raw);
      const map = st.noteDetailMap || {};
      const note = (id && map[id] && map[id].note) || (Object.values(map)[0] || {}).note || null;
      if (note) {
        const title = note.title || note.displayTitle || note.desc || '小红书笔记';
        const pickImg = (im) => im && (im.urlDefault || im.url || im.original ||
          (im.infoList && im.infoList.length ? im.infoList[im.infoList.length - 1].url : ''));
        const imgs = (note.imageList || []).map(pickImg).filter(Boolean).map(opUnescape).slice(0, 30);
        const stream = note.video && note.video.media && note.video.media.stream || null;
        let vurl = '';
        if (stream) {
          for (const c of [].concat(stream.h264 || [], stream.h265 || [], stream.av1 || [])) {
            if (c && c.master_url && !/\.m3u8/i.test(c.master_url)) { vurl = c.master_url; break; }
          }
        }
        if (vurl) return { kind: 'video', play: vurl, title, cover: imgs[0] || '', via };
        if (imgs.length) return { kind: 'images', images: imgs, title, cover: imgs[0], via };
      }
    } catch (e) { /* 状态剥不开，走 og 兜底 */ }
  }
  /* og 兜底 */
  const image = opOg(page.html, 'og:image');
  const video = opOg(page.html, 'og:video') || opOg(page.html, 'og:video:url');
  const title = opOg(page.html, 'og:title') || '小红书笔记';
  if (video) return { kind: 'video', play: video, title, cover: image, via };
  if (image) return { kind: 'images', images: [image], title, cover: image, via };
  return null;
}

/* ---------- 对外入口 ---------- */
const OP_ADAPTERS = {
  douyin: opDouyin,
  kuaishou: opKuaishou,
  bilibili: opBili,
  xiaohongshu: opXhs,
};

/** 浏览器端自研解析：成功返回统一结果，失败/不支持返回 null（由调用方继续走后续通道） */
async function ownBrowserParse(url, plat) {
  const fn = plat && OP_ADAPTERS[plat.key];
  if (!fn) return null;
  return await fn(url).catch(() => null);
}

/* 供测试与调试 */
globalThis.ownBrowserParse = ownBrowserParse;
globalThis.__opInternals = { opStates, opBalanced, opFetchPage, opUnescape, opVideoURLs, opImgURLs, adapters: OP_ADAPTERS };
