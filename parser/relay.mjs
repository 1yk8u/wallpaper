'use strict';
/* =====================================================================
 * parser/relay.mjs —— GitHub Actions 里跑的「自家代抓」
 *
 * 平台分流（每一条都是独立的开关，互不触发）：
 *   X / Twitter / twimg → xmedia.mjs：只在 X 链接时动态 import，
 *       经开源免费网关拿元数据 + 把图片/视频字节搬进 data/xmedia/
 *   网易云 / 汽水音乐  → music.mjs：官方音频字节 → data/audio/
 *   B站 / 通用直链      → engine.mjs 的 parse()
 *   抖音 / 快手 / 小红书 → render.mjs 的 renderParse()（真实浏览器）
 *
 * 关键约定：非 X 链接绝不加载 xmedia.mjs，也绝不向 X 的任何网关发请求。
 *
 * 输出：
 *   data/xmedia/<hash>.jpg|mp4   X 媒体字节（同源，永久有效）
 *   data/audio/<hash>.mp3|m4a    音乐字节
 *   data/parsed/<hash>.json      每条链接一个轻量结果，前端轮询它
 *   data/parse-cache.json        总缓存；音乐/X 按「平台:ID」键双写
 *
 * 约定：<hash> = sha256(key).hex.slice(0,16)
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { musicCacheKey, parseMusicLink } from './music.mjs';

/* engine.mjs / render.mjs 只给图片视频用，音乐与 X 通道完全不加载它们：
 *   ① 这两个 job 只依赖 relay.mjs + 各自模块，线上万一缺引擎文件也不连累
 *   ② 不碰 Playwright 依赖，启动更快
 * 下面三个小函数与 engine.mjs 逐字节同构，保证缓存键不变。 */
const ENGINE_VERSION = '1.2.0';
function extractURL(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>（）()【】，。]+/g);
  if (!m) return '';
  return m[0].replace(/[），。、！？…．»,;!?.)]+$/g, '');
}
function normalizeKey(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?&#]/)[0]
    .replace(/\/+$/, '');
}
function resultKey(u) {
  return crypto.createHash('sha256').update(normalizeKey(u)).digest('hex').slice(0, 16);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARSED_DIR = path.join(ROOT, 'data', 'parsed');
const CACHE_PATH = path.join(ROOT, 'data', 'parse-cache.json');

const MUSIC_RE = /(?:(?:music\.)?163\.com|qishui\.douyin\.com|music\.douyin\.com)/i;
const isMusicURL = u => MUSIC_RE.test(String(u || ''));
/* 与 parser/xmedia.mjs 的 X_RE、前端 PLATFORMS.x 保持同构 */
const X_RE = /(?:^|\.|\/)(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com|twimg\.com|t\.co)(?:\/|$)/i;
const isXURL = u => X_RE.test(String(u || ''));

/* 轻量平台识别（不加载引擎），只用于判断是否走免费接口 */
function detectPlatformFast(u) {
  const s = String(u || '').toLowerCase();
  if (/douyin\.com|iesdouyin\.com/.test(s)) return 'douyin';
  if (/kuaishou\.com|chenzhongtech|gifshow\.com/.test(s)) return 'kuaishou';
  if (/bilibili\.com|b23\.tv/.test(s)) return 'bilibili';
  if (/xiaohongshu\.com|xhslink\.com/.test(s)) return 'xiaohongshu';
  return '';
}

/* X 模块只在真的遇到 X 链接时才加载；缓存起来避免同一批里重复 import */
let X_MOD = null;
async function xmod() { return X_MOD || (X_MOD = await import('./xmedia.mjs')); }

function inputURLs() {
  const raw = String(process.env.PARSE_URLS || '').trim();
  if (!raw) return [];
  let arr;
  if (raw.startsWith('[')) {
    try { arr = JSON.parse(raw); } catch (e) { arr = []; }
  } else arr = raw.split(/[\n,，\s]+/);
  return [...new Set(arr.map(extractURL).filter(Boolean))].slice(0, 20);
}

function readCache() {
  try { const j = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); j.entries = j.entries || {}; return j; }
  catch (e) { return { updated: '', engine: ENGINE_VERSION, entries: {} }; }
}

const ts = () => new Date().toISOString();
const hashName = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

function writeLightByName(name, payload) {
  fs.mkdirSync(PARSED_DIR, { recursive: true });
  fs.writeFileSync(path.join(PARSED_DIR, name + '.json'), JSON.stringify(payload, null, 2));
}
const writeLight = (raw, payload) => writeLightByName(resultKey(raw), payload);
/* 前端 relayPoll(cacheKey) 只读 sha256(cacheKey) 命名的文件，
 * 音乐 / X 的键不是 normalizeKey，必须额外写一份 */
const writeKeyLight = (key, payload) => writeLightByName(hashName(key), payload);

function writeCache(keys, entry) {
  const cache = readCache();
  for (const k of keys) if (k) cache.entries[k] = entry;
  cache.updated = ts();
  cache.engine = ENGINE_VERSION;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** 小红书 cookie 来自仓库 Secrets：PARSE_COOKIES（a=1; b=2） */
function cookieFor(host) {
  const c = process.env.PARSE_COOKIES || '';
  if (!c) return { cookies: '', domains: [] };
  const root = host.replace(/^www\./, '').split('.').slice(-2).join('.');
  return { cookies: c, domains: ['.' + root, '.' + root.replace(/^/, '')] };
}

async function runOne(raw) {
  /* 音乐：服务端把字节抓进自家仓库，返回给前端的只有 localAudio 相对路径 */
  if (isMusicURL(raw)) {
    const r = await parseMusicLink(raw);
    return { ...r, via: r.source || '自家代抓', platformName: r.platform === 'qishui' ? '汽水音乐' : '网易云音乐' };
  }
  /* X：只有 X 链接才会走到这里并加载 xmedia.mjs */
  if (isXURL(raw)) {
    const m = await xmod();
    const r = await m.parseXLink(raw);
    return { ...r, platformName: 'X' };
  }
  /* 免费聚合接口优先：抖音 / 快手 / B站 / 小红书 2~3 秒出无水印直链，
   * 比无头浏览器渲染（几十秒 + 排队）快一个数量级。失败才回退老引擎。 */
  const FREE_PLATS = ['douyin', 'kuaishou', 'bilibili', 'xiaohongshu'];
  if (FREE_PLATS.includes(detectPlatformFast(raw))) {
    try {
      const { parseByFreeAPI } = await import('./free-api.mjs');
      const r = await parseByFreeAPI(raw);
      if (r) return r;
    } catch (e) {
      console.log('  免费接口未成功（' + String(e.message || e).slice(0, 80) + '），回退自研引擎');
    }
  }

  /* 非音乐、非 X 才动态加载引擎 */
  const eng = await import('./engine.mjs');
  const plat = eng.detectPlatform(raw);
  const key = plat.key;
  /* 渲染引擎平台：抖音 / 快手 / 小红书 */
  if (key === 'douyin' || key === 'kuaishou' || key === 'xiaohongshu') {
    const { renderParse } = await import('./render.mjs');
    let opt = { attempts: key === 'xiaohongshu' ? 2 : 4, kind: 'auto' };
    if (key === 'xiaohongshu') {
      const { cookies, domains } = cookieFor(new URL(raw).host);
      opt = { ...opt, cookies, cookieDomains: domains };
    }
    const r = await renderParse(raw, opt);
    return {
      kind: r.kind, images: r.images || [], play: r.play || '', cover: r.cover || '',
      title: r.title || '', via: r.via || '渲染引擎', platform: key,
      platformName: plat.name, ts: ts(),
    };
  }
  /* 其余平台（B站等）走原接口解析 */
  const r = await eng.parse(raw, { profile: false, log: () => {} });
  return {
    kind: r.kind, images: r.images || [], play: r.play || '', cover: r.cover || '',
    title: r.title || '', via: r.via || '接口', platform: r.platform || key,
    platformName: plat.name, ts: ts(),
  };
}

const urls = inputURLs();
if (!urls.length) {
  console.log('PARSE_URLS 为空，没有要解析的链接');
  process.exit(0);
}

console.log(`自研解析引擎 v${ENGINE_VERSION} · 待处理 ${urls.length} 条`);
let okN = 0, failN = 0;
const lines = [];

for (const raw of urls) {
  const baseKey = normalizeKey(raw);
  const music = isMusicURL(raw);
  const xlink = !music && isXURL(raw);
  const mKey = music ? musicCacheKey(raw) : '';
  const xKey = xlink ? (await xmod()).xCacheKey(raw) : '';
  /* 音乐 / X 只写「平台:ID」键：normalizeKey 会把同平台所有链接压成泛键，双写会串 */
  const cKey = mKey || xKey;
  const keys = cKey ? [cKey] : [baseKey];
  console.log('\n> ' + raw + (cKey ? '  [' + cKey + ']' : '') + (xlink ? '  [X 通道已启用]' : ''));
  try {
    const r = await runOne(raw);
    /* 音乐 / X 必须保留全部字段（localAudio / xAuthor / play / images 等），
     * 旧版只挑五个字段会把音频与视频信息全丢掉。 */
    const entry = cKey
      ? { ...r, engine: ENGINE_VERSION, ts: r.ts || ts() }
      : {
          kind: r.kind, images: r.images || [], play: r.play || '', cover: r.cover || '',
          title: r.title || '', via: r.via || '', platform: r.platform,
          engine: ENGINE_VERSION, ts: r.ts,
        };
    const light = { key: cKey || baseKey, ok: true, data: r, engine: ENGINE_VERSION, ts: ts() };
    writeLight(raw, light);
    if (cKey) writeKeyLight(cKey, light);
    writeCache(keys, entry);
    okN++;
    const n = r.kind === 'profile' ? (r.items?.length || 0) : (r.images?.length || (r.play ? 1 : 0));
    const pname = r.platformName || '-';
    console.log(`  OK ${pname} ${r.kind} ×${n} · ${r.via || ''}` +
      (r.localAudio ? ' → ' + r.localAudio + ' (' + r.audioSize + 'B)' : '') +
      (r.play ? ' → ' + r.play : ''));
    lines.push(`| OK | ${pname} | ${n} | ${r.via || ''} |`);
  } catch (e) {
    const error = { code: e.code || 'UNKNOWN', message: String(e.message || e).slice(0, 200) };
    const cacheNow = readCache().entries;
    const prior = cacheNow[cKey || baseKey] || cacheNow[baseKey];
    /* 之前成功过就别用失败覆盖；轻量文件里回吐旧结果，前端立刻能出图 */
    if (prior && !prior.err) {
      const light = {
        key: cKey || baseKey, ok: true, cached: true,
        data: { ...prior, kind: prior.kind, images: prior.images || [], play: prior.play || '', cover: prior.cover || '', title: prior.title || '' },
        engine: ENGINE_VERSION, ts: ts(),
      };
      writeLight(raw, light);
      if (cKey) writeKeyLight(cKey, light);
      console.log('  KEEP 已有成功缓存，本次失败不覆盖（' + error.message + '）');
      lines.push('| CACHED | - | - | 本次失败，回吐旧结果 |');
      okN++;
    } else {
      const light = { key: cKey || baseKey, ok: false, error, engine: ENGINE_VERSION, ts: ts() };
      writeLight(raw, light);
      if (cKey) writeKeyLight(cKey, light);
      writeCache(keys, { err: error.message, code: error.code, engine: ENGINE_VERSION, ts: ts() });
      console.log('  FAIL ' + error.code + ' · ' + error.message);
      lines.push(`| FAIL | ${error.code} | - | ${error.message.replace(/\|/g, '/').slice(0, 90)} |`);
      failN++;
    }
  }
  await new Promise(r => setTimeout(r, 600));
}

console.log(`\n完成：成功 ${okN}，失败 ${failN}`);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  try {
    fs.appendFileSync(summary,
      `## 自研解析引擎 v${ENGINE_VERSION}\n\n成功 ${okN} / 共 ${urls.length}\n\n| 状态 | 平台 | 数量 | 来源 |\n| --- | --- | --- | --- |\n${lines.join('\n')}\n`);
  } catch (e) { /* summary 可选 */ }
}
