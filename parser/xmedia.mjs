'use strict';
/* =====================================================================
 * parser/xmedia.mjs —— X（Twitter）专用代抓通道
 *
 * 【开关语义】本模块只由 relay.mjs 在「检测到 X 链接」时动态 import。
 *   非 X 链接（抖音 / 快手 / B站 / 小红书 / 网易云 / 汽水 / 其它）
 *   永远不会加载本模块，也不会向下面任何一个网关发出请求。
 *
 * 【开源免费通道】全部免密钥、无配额、来自开源项目：
 *   元数据 ① api.fxtwitter.com/status/<id>        FxEmbed / FxTwitter
 *          ② cdn.syndication.twimg.com/tweet-result  X 官方嵌入端点
 *          ③ api.vxtwitter.com/status/<id>          vxTwitter
 *   媒体   ① pbs.twimg.com / video.twimg.com       境外环境直取（含视频）
 *          ② images.weserv.nl/?url=...             weserv/images 开源图片网关（兜底）
 *
 * 【无限调用】媒体字节抓一次就永久存进自家仓库 data/xmedia/，
 *   之后同一条链接无论解析多少次都命中同源缓存，零网关请求、零 Actions 消耗。
 *
 * 【零第三方地址】回传给前端的只有 data/xmedia/... 相对路径。
 *   页面 DOM、img/video src、下载与入库字节里都不出现任何第三方 URL。
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = path.join(ROOT, 'data', 'xmedia');
const MEDIA_WEB = 'data/xmedia/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_PHOTOS = 12;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const KEEP_FILES = 90;              /* 仓库里最多留 90 个 X 媒体缓存，滚动淘汰 */
const FETCH_MS = 25000;

/* ---------- 链接识别（前端 extractor.js 的 PLATFORMS.x 与之同构） ---------- */
const X_RE = /(?:^|\.|\/)(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com|twimg\.com|t\.co)(?:\/|$)/i;
export const isXURL = u => X_RE.test(String(u || ''));

/** 缓存键：与前端 parseCacheKey 保持一致，按推文 ID 归一，去掉 /photo/1、?s=20 等尾巴 */
export function xCacheKey(u) {
  const s = String(u || '');
  const st = s.match(/(?:status|statuses)\/(\d{5,25})/);
  if (st) return 'x:' + st[1];
  const media = s.match(/(?:pbs|video)\.twimg\.com\/(?:media|amplify_video|ext_tw_video_thumb)\/([A-Za-z0-9_-]{5,60})/);
  if (media) return 'x:media:' + media[1].toLowerCase();
  return 'x:' + crypto.createHash('sha256').update(s.toLowerCase()).digest('hex').slice(0, 16);
}

function statusId(u) {
  const m = String(u || '').match(/(?:status|statuses)\/(\d{5,25})/);
  return m ? m[1] : '';
}

const ts = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

async function fetchT(url, opt = {}, ms = FETCH_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, 'accept': '*/*', ...(opt.headers || {}) },
      ...opt,
    });
  } finally { clearTimeout(timer); }
}

/* ---------- 元数据：三个开源/官方免费网关依次兜底 ---------- */
const META_GATES = [
  {
    name: 'FxTwitter（开源 FxEmbed）',
    url: id => 'https://api.fxtwitter.com/status/' + id,
    pick: j => (j && j.code === 200 && j.tweet) ? j.tweet : null,
  },
  {
    name: 'X 官方嵌入端点',
    url: id => 'https://cdn.syndication.twimg.com/tweet-result?id=' + id + '&lang=en&token=x',
    pick: j => (j && (j.text || j.id_str)) ? j : null,
  },
  {
    name: 'vxTwitter（开源）',
    url: id => 'https://api.vxtwitter.com/status/' + id,
    pick: j => (j && (j.text || j.tweetText)) ? j : null,
  },
];

function str(v) { return String(v == null ? '' : v); }
function uniq(a) { return [...new Set(a.filter(Boolean))]; }

/** 把三家不同形状的 JSON 归一成同一份结构 */
function normalise(t) {
  const author = t.author || t.user || {};
  const media = t.media || {};
  const photos = [];

  /* FxTwitter: media.photos[] / media.all[] */
  for (const p of (media.photos || [])) {
    if (p && typeof p === 'object' && p.url) photos.push(p.url);
    else if (typeof p === 'string') photos.push(p);
  }
  for (const p of (media.all || [])) if (p && p.type === 'photo' && p.url) photos.push(p.url);
  /* syndication: photos[] / mediaDetails[] / video */
  for (const p of (t.photos || [])) if (p && p.url) photos.push(p.url);
  for (const p of (t.mediaDetails || [])) if (p && p.type === 'photo' && p.media_url_https) photos.push(p.media_url_https);
  /* vxTwitter: mediaURLs[] */
  for (const p of (t.mediaURLs || [])) if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(str(p))) photos.push(p);
  if (typeof t.mediaURL === 'string' && /pbs\.twimg\.com/i.test(t.mediaURL)) photos.push(t.mediaURL);

  /* 视频：收集全部 mp4 档位，按码率从小到大依次尝试。
   * 小档文件更小、国内 Pages 加载更快，也更容易一次抓成功；抓到即停。 */
  const videoUrls = [];
  let videoThumb = '';
  const addVideo = (url, bitrate) => {
    if (url && !videoUrls.some(x => x.url === url)) videoUrls.push({ url, bitrate: Number(bitrate || 0) });
  };
  const vids = media.videos || t.videos || [];
  for (const v of vids) {
    if (!v) continue;
    const thumb = v.thumbnail_url || v.preview_image_url || v.poster || '';
    if (thumb) videoThumb = thumb;
    if (Array.isArray(v.formats)) for (const f of v.formats) {
      if (f && f.container === 'mp4' && f.url) addVideo(f.url, f.bitrate);
    }
    if (v.url && /\.mp4|video\.twimg\.com/i.test(str(v.url))) addVideo(v.url, 9000000);
  }
  /* syndication 的 variants */
  if (t.video) {
    for (const x of (t.video.variants || [])) if (x && /\.mp4/i.test(str(x.url))) addVideo(x.url, x.bitrate);
    if (t.video.poster) videoThumb = t.video.poster;
  }
  /* vxTwitter 的 mediaURLs */
  for (const p of (t.mediaURLs || [])) if (/\.mp4|video\.twimg\.com/i.test(str(p))) addVideo(p, 9000000);
  videoUrls.sort((a, b) => a.bitrate - b.bitrate);
  if (videoThumb) photos.unshift(videoThumb);

  return {
    handle: str(author.screen_name || author.name || t.screen_name || '').replace(/^@/, ''),
    author: str(author.name || author.screen_name || t.user_name || ''),
    avatar: str(author.profile_image_url_https || author.profile_image_url ||
               author.avatar_url || author.avatar || author.profileImage || ''),
    text: str(t.text || t.tweetText || t.full_text || ''),
    created: str(t.created_at || t.createdAt || ''),
    photos: uniq(photos).slice(0, MAX_PHOTOS + 1),
    videoUrls: videoUrls.slice(0, 6), videoThumb,
  };
}

async function loadMeta(id) {
  const errs = [];
  for (const g of META_GATES) {
    try {
      const r = await fetchT(g.url(id), { headers: { accept: 'application/json,*/*' } }, 15000);
      if (!r.ok) { errs.push(g.name + ' HTTP ' + r.status); continue; }
      const j = await r.json();
      const t = g.pick(j);
      if (!t) { errs.push(g.name + ' 空结果'); continue; }
      const n = normalise(t);
      if (!n.photos.length && !n.videoUrls.length) { errs.push(g.name + ' 无媒体'); continue; }
      n.gate = g.name;
      return n;
    } catch (e) { errs.push(g.name + ' ' + String(e.message || e).slice(0, 50)); }
  }
  throw new Error('X 免费网关都没取到媒体：' + errs.join(' / '));
}

/* ---------- 媒体字节：直取 → 开源图片网关兜底 ---------- */
function sniff(buf) {
  const b = buf;
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (b.length > 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';
  return '';
}

function weservURL(u) {
  /* url 必须是完整 https:// 且整体 URL 编码；源 URL 自带的 ?name=orig 会被编码进去 */
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(String(u).replace(/^http:/, 'https:')) +
    '&w=2000&output=jpg&q=88';
}

async function grabBytes(u, isVideo) {
  const tries = isVideo ? [u] : [u, weservURL(u)];
  const errs = [];
  for (const t of tries) {
    try {
      const r = await fetchT(t, {
        headers: {
          accept: isVideo ? 'video/mp4,*/*' : 'image/*,*/*',
          referer: 'https://x.com/',
        },
      }, isVideo ? 60000 : 30000);
      if (!r.ok) { errs.push('HTTP ' + r.status); continue; }
      const ct = str(r.headers.get('content-type'));
      if (/text\/html|application\/json/i.test(ct) && !isVideo) { errs.push('返回非图片 ' + ct); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = sniff(buf);
      if (!ext) { errs.push('不是媒体文件'); continue; }
      if (isVideo && ext !== 'mp4') { errs.push('非 mp4'); continue; }
      if (!isVideo && ext === 'mp4') { errs.push('拿到视频当图片'); continue; }
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (buf.length < 1000 || buf.length > cap) { errs.push('体积异常 ' + buf.length); continue; }
      return { buf, ext, size: buf.length, via: t === u ? '官方 CDN 直取' : 'weserv 开源图片网关' };
    } catch (e) { errs.push(String(e.message || e).slice(0, 60)); }
  }
  throw new Error(errs.join(' / '));
}

function trimMedia() {
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .filter(f => /^xm_[0-9a-f]{16}\.(jpg|png|webp|gif|mp4)$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(MEDIA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(KEEP_FILES)) fs.unlinkSync(path.join(MEDIA_DIR, x.f));
  } catch (e) { /* 目录不存在无所谓 */ }
}

function store(key, idx, bytes) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const name = 'xm_' + sha(key + '#' + idx) + '.' + bytes.ext;
  fs.writeFileSync(path.join(MEDIA_DIR, name), bytes.buf);
  return MEDIA_WEB + name;
}

/* ---------- 主入口 ---------- */
export async function parseXLink(raw) {
  const key = xCacheKey(raw);
  const id = statusId(raw);

  /* 直接粘贴 twimg 媒体直链：不用查元数据，直接搬字节 */
  if (!id && /twimg\.com/i.test(String(raw))) {
    const isVideo = /video\.twimg\.com|\.mp4/i.test(String(raw));
    const b = await grabBytes(String(raw), isVideo);
    const local = store(key, 0, b);
    trimMedia();
    return {
      kind: isVideo ? 'video' : 'images',
      images: isVideo ? [] : [local], play: isVideo ? local : '', cover: local,
      title: 'X 媒体', platform: 'x', platformName: 'X',
      via: 'X 专用通道 · ' + b.via, channel: 'x-only', source: b.via,
      xAuthor: '', xHandle: '', xText: '', xCreated: '', xAvatar: '',
      xPhotos: isVideo ? 0 : 1, xVideos: isVideo ? 1 : 0,
      ts: ts(),
    };
  }
  if (!id) throw new Error('没识别出推文 ID（链接里要有 /status/数字）');

  const meta = await loadMeta(id);
  const localImages = [];
  const failed = [];
  for (let i = 0; i < meta.photos.length && localImages.length < MAX_PHOTOS; i++) {
    try {
      const b = await grabBytes(meta.photos[i], false);
      localImages.push(store(key, 'p' + i, b));
    } catch (e) { failed.push('图' + (i + 1)); }
  }

  let localVideo = '';
  /* 多档依次尝试：任一档抓到即停，保证「能取到 X 视频」 */
  for (let i = 0; i < meta.videoUrls.length && !localVideo; i++) {
    try {
      const b = await grabBytes(meta.videoUrls[i].url, true);
      localVideo = store(key, 'v', b);
      console.log('  X 视频已取到：第 ' + (i + 1) + ' 档 · ' + b.size + 'B · ' + b.via);
    } catch (e) { failed.push('视频档' + (i + 1)); }
  }
  trimMedia();

  if (!localImages.length && !localVideo) {
    throw new Error('媒体字节一张都没搬下来：' + (failed.join('、') || meta.gate));
  }

  /* 作者头像也搬进仓库，卡片就有真实图标，且不露第三方地址 */
  let localAvatar = '';
  if (meta.avatar) {
    try { const b = await grabBytes(meta.avatar, false); localAvatar = store(key, 'a', b); } catch (e) {}
  }

  const text = meta.text.replace(/\s+/g, ' ').trim();
  const title = (meta.handle ? '@' + meta.handle + ' · ' : '') + (text ? text.slice(0, 60) : 'X 推文媒体');
  const cover = localImages[0] || localVideo;

  return {
    kind: localVideo ? 'video' : 'images',
    images: localImages,
    play: localVideo,
    cover,
    title,
    platform: 'x', platformName: 'X',
    via: 'X 专用通道 · ' + meta.gate + '（开源免费网关）',
    channel: 'x-only',
    source: meta.gate,
    xAuthor: meta.author, xHandle: meta.handle, xText: text,
    xCreated: meta.created, xAvatar: localAvatar,
    xPhotos: localImages.length, xVideos: localVideo ? 1 : 0,
    xFailed: failed,
    ts: ts(),
  };
}

/* 命令行自测：MUSIC_CLI=1 node parser/xmedia.mjs "https://x.com/..." */
if (process.env.XMEDIA_CLI === '1') {
  const u = process.argv[2];
  if (!u) { console.log('用法：XMEDIA_CLI=1 node parser/xmedia.mjs <X链接>'); process.exit(1); }
  parseXLink(u).then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error('FAIL', e.message); process.exit(2); });
}
