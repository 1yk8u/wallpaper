'use strict';
/* =====================================================================
 * parser/relay.mjs —— GitHub Actions 里跑的「自家代抓」
 *
 * 平台分流：
 *   网易云 / 汽水音乐      → music.mjs：服务端抓官方音频字节 → data/audio/，
 *                            前端只拿同源 localAudio，页面零第三方音频地址
 *   B站 / 通用直链          → engine.mjs 的 parse()（公开接口，秒级）
 *   抖音 / 快手 / 小红书    → render.mjs 的 renderParse()（真实浏览器）
 *
 * 输出：
 *   data/audio/<hash>.mp3|m4a  自家仓库里的音频字节（同源，永久有效）
 *   data/parsed/<hash>.json     每条链接一个轻量结果，前端轮询它
 *   data/parse-cache.json       总缓存；音乐按「平台:ID」键双写，兼容前端 serverCacheGet
 *
 * 约定：<hash> = sha256(key).hex.slice(0,16)
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { musicCacheKey, parseMusicLink } from './music.mjs';

/* engine.mjs / render.mjs 只给图片视频用，音乐通道完全不加载它们：
 *   ① 音乐 job 只依赖本文件 + music.mjs，线上万一缺引擎文件也不连累音乐
 *   ② 不碰 Playwright 依赖，启动更快
 * 下面三个小函数与 engine.mjs 逐字节同构，保证缓存键不变。 */
const ENGINE_VERSION = '1.1.0';
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
/* 前端 relayPoll(musicKey) 只读 sha256(musicKey) 命名的文件，必须额外写一份 */
const writeMusicLight = (key, payload) => writeLightByName(hashName(key), payload);

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
  /* 非音乐才动态加载引擎；音乐 job 不需要 engine.mjs / render.mjs */
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
  const mKey = music ? musicCacheKey(raw) : '';
  /* 音乐只写「平台:ID」键：normalizeKey 会把所有网易云歌曲压成
   * "music.163.com/song" 这种泛键，双写会串歌。图片/视频仍写 normalizeKey。 */
  const keys = music ? [mKey] : [baseKey];
  console.log('\n> ' + raw + (mKey ? '  [音乐键 ' + mKey + ']' : ''));
  try {
    const r = await runOne(raw);
    /* 音乐必须保留 title/artist/cover/localAudio/audioExt/size/source 等字段，
     * 旧版只挑 kind/images/play/cover/title 会把音频信息全丢掉。 */
    const entry = music
      ? { ...r, engine: ENGINE_VERSION, ts: r.ts || ts() }
      : {
          kind: r.kind, images: r.images || [], play: r.play || '', cover: r.cover || '',
          title: r.title || '', via: r.via || '', platform: r.platform,
          engine: ENGINE_VERSION, ts: r.ts,
        };
    const light = { key: mKey || baseKey, ok: true, data: r, engine: ENGINE_VERSION, ts: ts() };
    writeLight(raw, light);
    if (mKey) writeMusicLight(mKey, light);
    writeCache(keys, entry);
    okN++;
    const n = r.kind === 'profile' ? (r.items?.length || 0) : (r.images?.length || 1);
    const pname = r.platformName || '-';
    console.log(`  OK ${pname} ${r.kind} ×${n} · ${r.via || ''}` +
      (r.localAudio ? ' → ' + r.localAudio + ' (' + r.audioSize + 'B)' : ''));
    lines.push(`| OK | ${pname} | ${n} | ${r.via || ''} |`);
  } catch (e) {
    const error = { code: e.code || 'UNKNOWN', message: String(e.message || e).slice(0, 200) };
    const prior = readCache().entries[mKey || baseKey] || readCache().entries[baseKey];
    /* 之前成功过就别用失败覆盖；轻量文件里回吐旧结果，前端立刻能出图 */
    if (prior && !prior.err) {
      const light = {
        key: mKey || baseKey, ok: true, cached: true,
        data: { ...prior, kind: prior.kind, images: prior.images || [], play: prior.play || '', cover: prior.cover || '', title: prior.title || '' },
        engine: ENGINE_VERSION, ts: ts(),
      };
      writeLight(raw, light);
      if (mKey) writeMusicLight(mKey, light);
      console.log('  KEEP 已有成功缓存，本次失败不覆盖（' + error.message + '）');
      lines.push('| CACHED | - | - | 本次失败，回吐旧结果 |');
      okN++;
    } else {
      const light = { key: mKey || baseKey, ok: false, error, engine: ENGINE_VERSION, ts: ts() };
      writeLight(raw, light);
      if (mKey) writeMusicLight(mKey, light);
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
