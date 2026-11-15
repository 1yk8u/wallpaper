/* =====================================================================
 * parser/music.mjs —— 音乐代抓（GitHub Actions 侧，零第三方直连）
 *
 * 需求：汽水音乐 + 网易云都「不走直连」。
 *   浏览器端不再出现任何第三方音频地址（不进 DOM、不进 audio.src、
 *   不进下载 href、不进 window.open、也不由浏览器直接 fetch 第三方域名）。
 *   本模块在服务端把两家官方音频的【字节】抓下来，写成自家仓库
 *   data/audio/<hash>.mp3|.m4a，前端只 fetch 这个同源文件 → 本地 Blob。
 *
 * 附带收益：汽水官方音频 URL 带 dy_q 时间戳签名，几十分钟就 403 失效；
 *   落到自家仓库里之后变成永久有效的同源静态文件，缓存命中即秒出。
 *
 * 输出给前端的字段只有 localAudio（相对路径）等元数据，
 *   绝不含 https://... 的第三方音频地址。
 * ===================================================================== */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = path.join(ROOT, 'data', 'audio');
const AUDIO_WEB = 'data/audio/';
const COVER_DIR = path.join(ROOT, 'data', 'covers');
const COVER_WEB = 'data/covers/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const NE_H = { referer: 'https://music.163.com/' };
const MIN_BYTES = 20000;
const MAX_BYTES = 24 * 1024 * 1024;
const KEEP_FILES = 40;              /* 仓库里最多留 40 个音频缓存，滚动淘汰 */
const KEEP_COVERS = 80;

/* ---------- 缓存键：必须与前端 extractor.js / music.js 的 parseCacheKey 逐字节一致 ---------- */
export function musicCacheKey(u) {
  let s = String(u || '').trim();
  /* 整段分享口令只取第一条纯链接（与 core.js extractURL 同构，音乐链接没有编码尾巴） */
  const m = s.match(/https?:\/\/[^\s"'<>（）()【】，。]+/);
  if (m) s = m[0];
  const raw = s.toLowerCase();
  const ne = raw.match(/(?:music\.)?163\.com\/[^\s]*[?&]id=(\d{4,14})/);
  if (ne) return 'netease:' + ne[1];
  if (/qishui|music\.douyin\.com/.test(raw)) {
    const tr = raw.match(/track_id=(\d{10,20})/);
    if (tr) return 'qishui:' + tr[1];
    const qs = raw.match(/qishui\.douyin\.com\/(?:song|s)\/([a-z0-9]{6,20})/);
    if (qs) return 'qishui:' + qs[1];
  }
  return raw.replace(/^https?:\/\//, '').replace(/^www\./, '')
    .split(/[?&#]/)[0].replace(/\/+$/, '');
}

/* ---------- HTTP ---------- */
async function fetchT(url, opt = {}, ms = 30000) {
  return fetch(url, {
    ...opt,
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...(opt.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
}
const cleanJsonish = s => String(s).replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, 'null');
const unesc = s => String(s || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');

/* 深度优先找第一个符合条件的对象节点 */
const findNode = (node, pred, depth = 0) => {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findNode(n, pred, depth + 1); if (r) return r; } return null; }
  if (typeof node === 'object') {
    if (pred(node)) return node;
    for (const k in node) { const r = findNode(node[k], pred, depth + 1); if (r) return r; }
  }
  return null;
};

/* ---------- 只在这里联网取音频字节；取完立刻落盘，URL 不外传 ---------- */
async function grabBytes(url, extraHeaders = {}) {
  const r = await fetchT(String(url).replace(/^http:/, 'https:'),
    { headers: { accept: 'audio/*,*/*', ...extraHeaders } }, 60000);
  if (!r.ok) throw new Error('音频 HTTP ' + r.status);
  const ct = String(r.headers.get('content-type') || '');
  if (/text\/html|application\/json|text\/plain/i.test(ct)) throw new Error('返回的是网页/JSON，不是音频');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) throw new Error('音频大小异常 ' + buf.length);
  const isM4a = buf.slice(4, 8).toString('ascii') === 'ftyp';
  const isMp3 = buf.slice(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0);
  if (!isM4a && !isMp3) throw new Error('文件头不是音频(' + buf.slice(0, 12).toString('hex') + ')');
  return { buf, ext: isM4a ? 'm4a' : 'mp3', size: buf.length, mime: isM4a ? 'audio/mp4' : 'audio/mpeg' };
}

function trimAudio() {
  try {
    const files = fs.readdirSync(AUDIO_DIR).filter(f => /^au_[0-9a-f]{16}\.(mp3|m4a)$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(KEEP_FILES)) fs.unlinkSync(path.join(AUDIO_DIR, x.f));
  } catch (e) { /* 清理失败不影响本次结果 */ }
}

function storeAudio(key, bytes) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const name = 'au_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '.' + bytes.ext;
  fs.writeFileSync(path.join(AUDIO_DIR, name), bytes.buf);
  trimAudio();
  return {
    localAudio: AUDIO_WEB + name,
    audioExt: bytes.ext,
    audioSize: bytes.size,
    audioMime: bytes.mime,
  };
}

/* ---------- 封面也落到自家仓库：卡片图标同源，不怕防盗链 / 跨域 ---------- */
function trimCovers() {
  try {
    const files = fs.readdirSync(COVER_DIR).filter(f => /^cv_[0-9a-f]{16}\.(jpg|png|webp|gif)$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(COVER_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(KEEP_COVERS)) fs.unlinkSync(path.join(COVER_DIR, x.f));
  } catch (e) { /* 清理失败不影响本次结果 */ }
}
function storeCover(key, img) {
  fs.mkdirSync(COVER_DIR, { recursive: true });
  const name = 'cv_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '.' + img.ext;
  fs.writeFileSync(path.join(COVER_DIR, name), img.buf);
  trimCovers();
  return COVER_WEB + name;
}
async function localizeCover(cover, key, referer) {
  if (!cover || !/^https?:\/\//.test(String(cover))) return cover || '';
  try {
    let u = String(cover).replace(/^http:/, 'https:');
    /* 网易云 CDN 原图动辄 5MB（而且标 image/jpg 实际是 PNG），
     * 用官方缩略图参数压到 ~60KB，再按真实文件头定扩展名。 */
    if (/music\.126\.net/i.test(u) && !/param=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'param=200y200';
    const r = await fetchT(u,
      { headers: { accept: 'image/*,*/*', ...(referer ? { referer } : {}) } }, 20000);
    if (!r.ok) return cover;
    const ct = String(r.headers.get('content-type') || '');
    if (!/^image\//i.test(ct)) return cover;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000 || buf.length > 3 * 1024 * 1024) return cover;
    const h = buf.slice(0, 12).toString('hex');
    let ext = '';
    if (h.startsWith('ffd8ff')) ext = 'jpg';
    else if (h.startsWith('89504e47')) ext = 'png';
    else if (h.startsWith('52494646') && h.includes('57454250')) ext = 'webp';
    else if (h.startsWith('47494638')) ext = 'gif';
    else ext = /png/i.test(ct) ? 'png' : /webp/i.test(ct) ? 'webp' : 'jpg';
    return storeCover(key, { buf, ext });
  } catch (e) { return cover; }
}

/* ---------- 网易云：官方公开接口取元数据 + 试听地址 ---------- */
async function neteaseMeta(id) {
  const d = await (await fetchT(
    'https://music.163.com/api/song/detail?ids=' + encodeURIComponent('[' + id + ']'),
    { headers: NE_H }, 30000)).json();
  const q = d && d.songs && d.songs[0];
  if (!q) throw new Error('网易云查无此歌(id ' + id + ')');
  const al = q.album || q.al || {};
  return {
    title: q.name || '网易云歌曲',
    artist: ((q.artists || q.ar || []).map(a => a.name)).filter(Boolean).join(' / '),
    album: al.name || '',
    cover: al.picUrl || '',
  };
}

async function neteaseAudio(id, key) {
  let src = '';
  try {
    const p = await (await fetchT(
      'https://music.163.com/api/song/enhance/player/url?ids=' + encodeURIComponent('[' + id + ']') + '&br=128000',
      { headers: NE_H }, 30000)).json();
    src = (p && p.data && p.data[0] && p.data[0].url) || '';
  } catch (e) { /* 回退 outer */ }
  if (!src) src = 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3';
  const bytes = await grabBytes(src, NE_H);
  return storeAudio(key, bytes);
}

async function parseNeteaseMusic(id, key) {
  const meta = await neteaseMeta(id);
  const audio = await neteaseAudio(id, key);
  const cover = await localizeCover(meta.cover, key, 'https://music.163.com/');
  return {
    kind: 'music', platform: 'netease', id: String(id),
    ...meta, cover, ...audio, matched: false, source: '网易云官方试听（自家仓库同源缓存）',
  };
}

/* ---------- 汽水：官方分享页 SSR 数据里自带原版音频 ---------- */
async function resolveShort(url) {
  try {
    const r = await fetchT(url, { redirect: 'follow' }, 20000);
    return r.url || url;
  } catch (e) { return url; }
}

function qishuiRouter(html, trackId) {
  const om = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
  const ogCover = (om && !/favicon|logo/i.test(om[1])) ? String(om[1]).replace(/&amp;/g, '&') : '';
  const rm = html.match(/_ROUTER_DATA\s*=\s*/);
  if (!rm) throw new Error('汽水页面没有 _ROUTER_DATA');
  const start = html.indexOf('{', rm.index + rm[0].length);
  if (start < 0) throw new Error('汽水 _ROUTER_DATA 不是对象');
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
  if (end <= start) throw new Error('汽水 _ROUTER_DATA 括号不完整');
  let j;
  try { j = JSON.parse(cleanJsonish(html.slice(start, end))); }
  catch (e) { throw new Error('汽水 _ROUTER_DATA 解析失败: ' + (e.message || e)); }

  /* 官方原版音频节点：url 带 mime_type=audio_mp4，且节点里有歌名/歌手 */
  const ao = findNode(j, o => o && o.url &&
    /mime_type=audio_mp4|douyinvod/i.test(String(o.url)) &&
    !!(o.trackName || o.name || o.artistName));
  const audioUrl = ao ? unesc(ao.url) : '';

  /* 元数据优先取音频节点自带字段，其次按 track_id 找曲目节点 */
  let title = '', artist = '', album = '', cover = ogCover;
  if (ao) {
    title = String(ao.trackName || ao.name || '').trim();
    artist = String(ao.artistName || '').trim() ||
      (Array.isArray(ao.artists) ? ao.artists.map(a => a.name || a.simple_display_name || '').filter(Boolean).join(' / ') : '');
    album = String(ao.albumName || (ao.album && ao.album.name) || '').trim();
    const c = ao.coverURL || ao.cover || (ao.album && (ao.album.coverURL || ao.album.url_cover));
    if (c && typeof c === 'string') cover = unesc(c);
  }
  if (!title && trackId) {
    const node = findNode(j, o => o && String(o.id) === String(trackId) && !!o.name);
    if (node) {
      title = String(node.name || '').trim();
      artist = (Array.isArray(node.artists) ? node.artists : [])
        .map(a => a.simple_display_name || a.name || '').filter(Boolean).join(' / ');
      album = ((node.album || {}).name) || '';
      if (!cover) {
        const uc = (node.album || {}).url_cover || node.url_cover;
        if (uc && uc.uri && Array.isArray(uc.urls) && uc.urls.length) {
          cover = String(uc.urls[0]).replace(/\/+$/, '') + '/' + unesc(uc.uri);
        }
      }
    }
  }
  if (!title) throw new Error('汽水页面没有歌曲数据(该曲可能不支持网页播放)');
  return { title, artist, album, cover, audioUrl };
}

/* 汽水官方音频失效时：拿核心歌名 + 歌手去网易云匹配同名版本。
 * 不能用带副标题的全名搜（Gasolina（何为张力） 会搜偏到《何为张力》）。 */
async function matchNetease(title, artist) {
  const core = String(title).replace(/[（(][^）)]*[）)]/g, '').trim();
  const norm = x => String(x || '').toLowerCase()
    .replace(/[\s（）()\[\]【】《》「」·・.\-—–_|]/g, '');
  const queries = [];
  if (core && artist) queries.push(core + ' ' + artist);
  if (title !== core && artist) queries.push(title + ' ' + artist);
  if (core) queries.push(core);
  const cands = [], seen = new Set();
  for (const q of [...new Set(queries)].slice(0, 3)) {
    try {
      const d = await (await fetchT(
        'https://music.163.com/api/search/get?s=' + encodeURIComponent(q) + '&type=1&limit=8',
        { headers: NE_H }, 30000)).json();
      for (const s of ((d && d.result && d.result.songs) || [])) {
        const id = String(s.id);
        if (seen.has(id)) continue;
        seen.add(id);
        cands.push({ id, name: s.name || '', artist: ((s.artists || s.ar) || []).map(a => a.name).join(' / ') });
      }
      if (artist && cands.some(c => norm(c.name) === norm(core) && norm(c.artist).includes(norm(artist)))) break;
    } catch (e) { /* 换下一组关键词 */ }
  }
  let best = null, bs = -1;
  for (const c of cands) {
    const n = norm(c.name), cn = norm(core), wn = norm(title), ca = norm(c.artist), wa = norm(artist);
    let sc = 0;
    if (n && n === wn) sc += 3;
    else if (n && n === cn) sc += 2.5;
    else if (cn && (n.includes(cn) || cn.includes(n))) sc += 1.5;
    else if (wn && (n.includes(wn) || wn.includes(n))) sc += 1.2;
    if (wa && ca && (ca.includes(wa) || wa.includes(ca))) sc += 3;
    if (sc > bs) { bs = sc; best = c; }
  }
  return (best && bs >= 1.2) ? best : null;
}

async function parseQishuiMusic(url, key) {
  let trackId = (String(url).match(/track_id=(\d{10,20})/) || [])[1] || '';
  if (!trackId) {
    const finalURL = await resolveShort(url);
    trackId = (String(finalURL).match(/track_id=(\d{10,20})/) || [])[1] || '';
  }
  if (!trackId) throw new Error('汽水：该分享不是单曲链接，且链接里没有 track_id');
  const html = await (await fetchT(
    'https://music.douyin.com/qishui/share/track?track_id=' + trackId,
    { headers: { accept: 'text/html,application/xhtml+xml' } }, 30000)).text();
  const meta = qishuiRouter(html, trackId);
  const out = {
    kind: 'music', platform: 'qishui', id: trackId,
    title: meta.title, artist: meta.artist, album: meta.album, cover: meta.cover,
  };
  out.cover = await localizeCover(out.cover, key, 'https://music.douyin.com/');
  if (meta.audioUrl) {
    try {
      const b = await grabBytes(meta.audioUrl, { referer: 'https://music.douyin.com/' });
      return { ...out, ...storeAudio(key, b), matched: false, source: '汽水官方原版音频（自家仓库同源缓存）' };
    } catch (e) {
      console.log('  汽水官方音频暂不可用(' + (e.message || e) + ')，走同名匹配兜底');
    }
  }
  const best = await matchNetease(meta.title, meta.artist);
  if (!best) throw new Error('汽水官方音频暂不可用，也没找到网易云同名版本');
  const b = await neteaseAudio(best.id, key);
  return {
    ...out, ...b, matched: true, matchedId: best.id,
    matchedName: best.name, matchedArtist: best.artist,
    source: '网易云同名版本（自家仓库同源缓存）',
  };
}

/* ---------- 对外入口 ---------- */
export async function parseMusicLink(raw) {
  const url = String(raw || '').trim();
  const key = musicCacheKey(url);
  let result;
  if (key.startsWith('netease:')) result = await parseNeteaseMusic(key.slice(8), key);
  else if (key.startsWith('qishui:')) result = await parseQishuiMusic(url, key);
  else throw new Error('不是支持的音乐分享链接（只支持网易云 / 汽水单曲）');
  return { ...result, key, ts: new Date().toISOString() };
}

/* 本地自测：MUSIC_CLI=1 node parser/music.mjs "<链接>" */
if (process.env.MUSIC_CLI === '1' && process.argv[2]) {
  try {
    const r = await parseMusicLink(process.argv[2]);
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('FAIL ' + (e.message || e));
    process.exitCode = 1;
  }
}
