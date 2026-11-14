/* =====================================================================
 * parse-queue.mjs —— 自家解析中转（GitHub Actions 代抓）
 * 由 .github/workflows/parse-queue.yml 触发；结果写入 data/parse-cache.json，
 * 与前端 kuaishouItemFromPhoto / prepareKey(ksCacheKey) 完全同构。
 * 输入：env.PARSE_URLS（换行/逗号分隔的链接）
 * ===================================================================== */
import fs from 'node:fs';
import crypto from 'node:crypto';

const CACHE_PATH = new URL('../data/parse-cache.json', import.meta.url);
/* 单条轻量结果：前端轮询只读这个 <2KB 的文件，不必反复下载 600KB 总缓存。
 * 文件名算法必须与前端 extractor.js 的 sha256(key).slice(0,16) 一致。 */
const PARSED_DIR = new URL('../data/parsed/', import.meta.url);
const parsedName = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '.json';
function writeLight(key, entry) {
  try {
    /* 老缓存条目可能没有 ts；补一个当前时间，前端轮询才会认定「这是本次结果」 */
    const out = { ...(entry || {}), key, ts: (entry && entry.ts) || new Date().toISOString() };
    fs.mkdirSync(PARSED_DIR, { recursive: true });
    fs.writeFileSync(new URL(parsedName(key), PARSED_DIR),
      JSON.stringify(out, null, 2));
    console.log('LIGHT ' + parsedName(key));
  } catch (e) {
    console.log('轻量结果写入失败（总缓存不受影响）：' + (e.message || e));
  }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---------- 小工具 ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchT(url, opt = {}, ms = 30000) {
  try {
    return await fetch(url, {
      ...opt,
      headers: { 'user-agent': UA, ...(opt.headers || {}) },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    /* 留痕：把 undici 的底层原因（DNS/TLS/RST/超时）带进错误信息 */
    const c = (e && e.cause) || {};
    throw new Error('网络失败[' + (c.code || c.name || 'unknown') + '] ' + (c.message || e.message) + ' ← ' + url);
  }
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
/* 深度优先找第一个符合条件的对象节点（抖音 _ROUTER_DATA 用） */
const findNode = (node, pred, depth = 0) => {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findNode(n, pred, depth + 1); if (r) return r; } return null; }
  if (typeof node === 'object') {
    if (pred(node)) return node;
    for (const k in node) { const r = findNode(node[k], pred, depth + 1); if (r) return r; }
  }
  return null;
};
/* 链接净化：与前端 core.js 的 safePctDecode / extractURL 逐字节同构。
 * 快手等 App 的分享口令常把链接整段 URL 编码后拼上标题
 * （"https://v.kuaishou.com/JVPUEMk2%20%22%E9%A3%8E…"），
 * 直接拿去请求会 404 → 「无法从链接提取快手作品号」。 */
function safePctDecode(s) {
  let t = String(s || '');
  for (let i = 0; i < 6; i++) {
    try { return decodeURIComponent(t); } catch (e) {
      const cut = t.replace(/%[0-9a-fA-F]{0,1}$/, '').replace(/%[0-9a-fA-F]{2}$/, '');
      if (cut === t) break;
      t = cut;
    }
  }
  return t;
}
function sanitizeUrl(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  let src = raw;
  if (/%[0-9a-fA-F]{2}/i.test(raw)) {
    const dec = safePctDecode(raw);
    if (/https?:\/\//i.test(dec)) src = dec;
  }
  const m = src.match(/https?:\/\/[^\s"'<>（）()【】，。]+/);
  if (m) src = m[0];              /* 非 URL（如 netease:123）原样保留 */
  let u = src.split(/%(?:20|22|09|0a|0d|23|3f|26|3c|3e|27|28|29|2c|2e|3b|21)/i)[0];
  u = u.replace(/%[0-9a-fA-F]{0,1}$/i, '');
  u = u.replace(/[），。、！？！?…．»,]+$/g, '');
  u = u.replace(/[),.;!?]+$/g, '');
  return u;
}

/* 缓存键：必须与前端 extractor.js/music.js 的 cacheKey 逐字节一致。
 * 音乐用「平台:ID」做键——音乐链接的 query（id=/track_id=）绝不能被剥掉，否则所有歌撞一个键。
 * 汽水两种分享形态：/s/<短码>（大小写敏感但键统一小写）与 track_id=（数字）。 */
const cacheKey = (u) => {
  const raw = String(sanitizeUrl(u) || u || '').trim().toLowerCase();
  const ne = raw.match(/(?:music\.)?163\.com\/[^\s]*[?&]id=(\d{4,14})/);
  if (ne) return 'netease:' + ne[1];
  if (/qishui|music\.douyin\.com/.test(raw)) {
    const tr = raw.match(/track_id=(\d{10,20})/);
    if (tr) return 'qishui:' + tr[1];
    const qs = raw.match(/qishui\.douyin\.com\/(?:song|s)\/([a-z0-9]{6,20})/);
    if (qs) return 'qishui:' + qs[1];
  }
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?&#]/)[0]
    .replace(/\/+$/, '');
};

/* ---------- 各平台解析 ---------- */
async function resolveShort(url) {
  try {
    const r = await fetchT(url, { redirect: 'follow' }, 20000);
    return r.url || url;
  } catch (e) { return url; }
}

async function parseKuaishou(finalURL) {
  /* 自家接口：快手 h5 分享页自己的数据 API（零第三方，POST JSON）
   * 旧的 SSR __APOLLO_STATE__ 方案已失效（页面改为纯客户端渲染），改走这个。 */
  const code = (finalURL.match(/(?:short-video|fw\/photo|\/photo)\/([a-z0-9]{6,20})/i)
    || finalURL.match(/[?&]photoId=([a-z0-9]{6,20})/i) || [])[1];
  if (!code) throw new Error('无法从链接提取快手作品号 ← ' + finalURL);
  const r = await fetchT('https://m.gifshow.com/rest/wd/ugH5App/photo/simple/info', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      referer: 'https://m.gifshow.com/fw/photo/' + code,
      origin: 'https://m.gifshow.com',
    },
    body: JSON.stringify({ photoId: code }),
  }, 30000);
  const j = await r.json();
  if (!j || j.result !== 1 || !j.photo) {
    const msg = j && (j.error_msg || ('result=' + j.result));
    if (j && (j.result === 11 || j.result === 223)) throw new Error('作品已删除/不存在');
    throw new Error('快手接口: ' + (msg || '无数据'));
  }
  const p = j.photo;
  const title = String(p.caption || '').replace(/\s+/g, ' ').slice(0, 80) || '快手作品';
  const cover0 = (Array.isArray(p.coverUrls) && p.coverUrls[0]) || '';
  /* 视频优先 */
  const mvUrl = Array.isArray(p.mainMvUrls) && p.mainMvUrls[0]
    ? (typeof p.mainMvUrls[0] === 'string' ? p.mainMvUrls[0] : (p.mainMvUrls[0].url || '')) : '';
  if (mvUrl && /\.(mp4|m3u8)/i.test(mvUrl)) return { kind: 'video', play: unesc(mvUrl), title, cover: cover0 };
  /* 图集：atlas.list（相对路径）× atlas.cdn（CDN 域名） */
  const atlas = (j.atlas && Array.isArray(j.atlas.list) && j.atlas.list.length) ? j.atlas
    : (p.ext_params && p.ext_params.atlas) || null;
  if (atlas && Array.isArray(atlas.list) && atlas.list.length) {
    const cdnHost = (Array.isArray(atlas.cdn) && atlas.cdn[0]) ||
      (Array.isArray(atlas.cdnList) && atlas.cdnList[0] && atlas.cdnList[0].cdn) || 'p2.a.yximgs.com';
    const imgs = [...new Set(atlas.list.map(x => 'https://' + cdnHost + x))].slice(0, 30);
    if (imgs.length) return { kind: 'images', images: imgs, title, cover: cover0 || imgs[0] };
  }
  /* 单图兜底 */
  if (p.singlePicture && /^https?:\/\//.test(String(p.singlePicture))) {
    return { kind: 'images', images: [String(p.singlePicture)], title, cover: cover0 || String(p.singlePicture) };
  }
  throw new Error('快手接口没有可取的媒体');
}

async function parseDouyin(finalURL) {
  /* 抖音自家分享页直抓（iesdouyin）：_ROUTER_DATA 里有作品数据，不依赖任何第三方接口 */
  const id = (finalURL.match(/\/video\/(\d+)/) || finalURL.match(/\/note\/(\d+)/) ||
    finalURL.match(/modal_id=(\d+)/) || finalURL.match(/share\/video\/(\d+)/) || [])[1];
  if (!id) throw new Error('无法识别抖音作品号');
  const html = await (await fetchT('https://www.iesdouyin.com/share/video/' + id + '/', { headers: { accept: 'text/html,application/xhtml+xml' } }, 30000)).text();
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error('抖音分享页无 _ROUTER_DATA(html长度' + html.length + ')');
  const j = JSON.parse(String(m[1]).replace(/undefined/g, 'null').replace(/\bNaN\b/g, 'null'));
  const item = findNode(j, o => !!(o && (o.play_addr || o.images)));
  if (!item) throw new Error('抖音数据里没有作品');
  const imgs = imgCands(item).slice(0, 30);
  const vids = vidCands(item);
  const title = item.desc || item.title || '抖音内容';
  if (imgs.length) return { kind: 'images', images: imgs, title, cover: imgs[0] };
  if (vids.length) return { kind: 'video', play: vids[0], title, cover: imgs[0] || '' };
  throw new Error('抖音作品没有可取的媒体');
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

/* ---------- 音乐：网易云 / 汽水（全部走平台自家接口，零第三方） ---------- */
const NE_API_H = { headers: { referer: 'https://music.163.com/' } };
async function parseNeteaseMusic(id) {
  const d = await (await fetchT('https://music.163.com/api/song/detail?ids=' + encodeURIComponent('[' + id + ']'), NE_API_H, 30000)).json();
  const q = d && d.songs && d.songs[0];
  if (!q) throw new Error('网易云查无此歌(id ' + id + ')');
  const artist = ((q.artists || q.ar || []).map(a => a.name)).filter(Boolean).join(' / ');
  const album = q.album || q.al || {};
  return {
    kind: 'music', platform: 'netease', id: String(id),
    title: q.name || '网易云歌曲', artist, album: album.name || '',
    cover: album.picUrl || '',
    audio: 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3',
    matched: false,
  };
}
async function parseQishuiMusic(trackId, pageUrl) {
  /* 汽水歌曲分享页（music.douyin.com/qishui/share/track）自带 SSR 的 _ROUTER_DATA：
   * 歌名/歌手/专辑/封面/vid 全在里面——汽水自家页面，零第三方。
   * 汽水未开放网页直链 → 拿真实歌名+歌手去网易云公开搜索匹配同名版本（matched=true，前端标注）。 */
  const target = trackId
    ? 'https://music.douyin.com/qishui/share/track?track_id=' + trackId
    : '';
  if (!target) throw new Error('汽水：该分享不是单曲链接（歌单/视频暂不支持），且链接里没有 track_id');
  const html = await (await fetchT(target, { headers: { accept: 'text/html,application/xhtml+xml' } }, 30000)).text();
  /* 平衡括号截取 _ROUTER_DATA（对象里可能嵌着 </script> 字样以外的干扰） */
  let node = null, ogCover = '';
  const om = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  if (om && !/favicon|logo/i.test(om[1])) ogCover = om[1];
  const rm = html.match(/_ROUTER_DATA\s*=\s*/);
  if (rm) {
    const start = html.indexOf('{', rm.index + rm[0].length);
    if (start >= 0) {
      let depth = 0, inStr = false, esc2 = false, end = -1;
      for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inStr) {
          if (esc2) esc2 = false;
          else if (c === '\\') esc2 = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > start) {
        try {
          const j = JSON.parse(cleanJsonish(html.slice(start, end)));
          if (trackId) {
            node = findNode(j, o => o && String(o.id) === String(trackId) && !!o.name && (o.artists || o.media_type === 'track'));
          }
        } catch (e) { /* JSON 挂了就走兜底 */ }
      }
    }
  }
  if (!node) throw new Error(trackId ? '汽水页面没有歌曲数据(该曲可能不支持网页播放)' : '汽水页面无法解析');
  const title = String(node.name || '').trim();
  const artist = (Array.isArray(node.artists) ? node.artists : [])
    .map(a => a.simple_display_name || a.name || '').filter(Boolean).join(' / ');
  const album = ((node.album || {}).name) || '';
  let cover = ogCover;
  if (!cover) {
    const uc = (node.album || {}).url_cover || node.url_cover;
    if (uc && uc.uri && Array.isArray(uc.urls) && uc.urls.length) {
      cover = String(uc.urls[0]).replace(/\/+$/, '') + '/' + String(uc.uri).replace(/\\u002F/g, '/');
    }
  }
  /* 网易云同名匹配（拿真实歌名+歌手搜，命中率高；结果 matched=true 明确标注） */
  let audio = '', matched = false, matchedId = '';
  try {
    const q = (title + ' ' + artist).trim();
    const d = await (await fetchT('https://music.163.com/api/search/get?s=' + encodeURIComponent(q) + '&type=1&limit=5', NE_API_H, 30000)).json();
    const list = (d && d.result && d.result.songs) || [];
    const hit = list[0];
    if (hit) {
      matched = true; matchedId = String(hit.id);
      audio = 'https://music.163.com/song/media/outer/url?id=' + matchedId + '.mp3';
    }
  } catch (e) { /* 匹配失败就只给打开原曲 */ }
  const out = { kind: 'music', platform: 'qishui', id: String(trackId || ''), title, artist, album, cover, audio, matched };
  if (matchedId) out.matchedId = matchedId;
  return out;
}
/* JSON 里的裸 undefined/NaN 修掉（与前端 cleanJson 同构） */
const cleanJsonish = (s) => String(s).replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, 'null');

/* ---------- 主流程 ---------- */
const urls = String(process.env.PARSE_URLS || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
if (!urls.length) { console.log('PARSE_URLS 为空，无事可做'); process.exit(0); }

let cache = { updated: '', entries: {} };
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (e) {}
cache.entries = cache.entries || {};

let changed = 0;
for (const raw of urls) {
  const url = sanitizeUrl(raw);   /* 口令里的编码标题必须在请求前剥掉 */
  const key = cacheKey(url);
  if (!key) continue;
  const prior = cache.entries[key];
  const hasGood = !!(prior && !prior.err);
  try {
    const finalURL = await resolveShort(url);
    console.log('RESOLVE ' + key + ' → ' + finalURL);
    let result = null;
    if (key.startsWith('netease:')) {
      result = await parseNeteaseMusic(key.slice(8));
    } else if (key.startsWith('qishui:')) {
      /* 键后缀可能是数字 track_id，也可能是 /s/<短码>——短码靠重定向后的 finalURL 提取真 track_id */
      const suffix = key.slice(7);
      const trFromUrl = (String(finalURL).match(/track_id=(\d{10,20})/) || [])[1] || '';
      const tr = /^\d{10,20}$/.test(suffix) ? suffix : trFromUrl;
      result = await parseQishuiMusic(tr, finalURL);
    } else {
      const isKs = /kuaishou\.com|chenzhongtech/i.test(finalURL) || /kuaishou\.com|chenzhongtech/i.test(url);
      const isDouyin = /douyin\.com|iesdouyin\.com/i.test(finalURL) || /douyin\.com|iesdouyin\.com/i.test(url);
      const isBili = /bilibili\.com|b23\.tv/i.test(finalURL) || /bilibili\.com|b23\.tv/i.test(url);
      const isXhs = /xiaohongshu\.com|xhslink\.com/i.test(finalURL) || /xiaohongshu\.com|xhslink\.com/i.test(url);
      if (isKs) result = await parseKuaishou(finalURL).catch(e => { throw new Error('快手 SSR：' + (e.message || e)); });
      else if (isDouyin) result = await parseDouyin(finalURL);
      else if (isBili) result = await parseBilibili(finalURL);
      else if (isXhs) result = await parseXhs(finalURL);
      else { console.log('SKIP 不支持的平台：' + key); continue; }
    }

    if (result) {
      cache.entries[key] = { ...result, ts: new Date().toISOString() };
      writeLight(key, cache.entries[key]);
      changed++;
      console.log('OK ' + key + ' → ' + result.kind + ' ×' + (result.images ? result.images.length : 1));
    } else if (hasGood) {
      /* 已有成功结果也补一份轻量文件：前端可能因 Pages 延迟没命中缓存而重复派单 */
      writeLight(key, prior);
      console.log('KEEP ' + key + '（代抓没取到，但已有成功结果，不覆盖）');
    } else {
      cache.entries[key] = { err: '代抓未取到内容（页面结构变化或需登录）', ts: new Date().toISOString() };
      writeLight(key, cache.entries[key]);
      changed++;
      console.log('FAIL ' + key + '（写err，前端会给提示）');
    }
  } catch (e) {
    if (hasGood) {
      writeLight(key, prior);
      console.log('ERR ' + key + '：' + (e.message || e) + '（保留已有成功结果）');
    } else {
      cache.entries[key] = { err: String(e.message || e).slice(0, 120), ts: new Date().toISOString() };
      writeLight(key, cache.entries[key]);
      changed++;
      console.log('ERR ' + key + '：' + (e.message || e));
    }
  }
  await sleep(800); /* 温和节奏，别触发风控 */
}

cache.updated = new Date().toISOString();
if (changed) fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
console.log('新增/更新 ' + changed + ' 条 → data/parse-cache.json');
