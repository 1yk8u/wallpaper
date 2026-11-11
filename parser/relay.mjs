'use strict';
/* =====================================================================
 * parser/relay.mjs —— GitHub Actions 里跑的「自家代抓」
 *
 * 平台分流：
 *   B站 / 通用直链        → engine.mjs 的 parse()（服务端直接调公开接口，秒级）
 *   抖音 / 快手 / 小红书  → render.mjs 的 renderParse()（开真实浏览器让平台
 *                          自己把直链交出来；小红书需 PARSE_COOKIES 登录态）
 *
 * 输出：
 *   data/parsed/<hash>.json   每条链接一个轻量结果，前端轮询它（实时、无 Pages 延迟）
 *   data/parse-cache.json     总缓存，兼容旧版前端，短链 key 与长链 key 双写
 *
 * 约定：<hash> = sha256(normalizeKey(用户输入链接)).hex.slice(0,16)
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parse, extractURL, normalizeKey, resultKey, detectPlatform, ENGINE_VERSION,
} from './engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARSED_DIR = path.join(ROOT, 'data', 'parsed');
const CACHE_PATH = path.join(ROOT, 'data', 'parse-cache.json');

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

function writeLight(raw, payload) {
  fs.mkdirSync(PARSED_DIR, { recursive: true });
  fs.writeFileSync(path.join(PARSED_DIR, resultKey(raw) + '.json'), JSON.stringify(payload, null, 2));
}

function writeCache(key, finalKey, entry) {
  const cache = readCache();
  cache.entries[key] = entry;
  if (finalKey && finalKey !== key) cache.entries[finalKey] = entry;
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
  const plat = detectPlatform(raw);
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
  const r = await parse(raw, { profile: false, log: () => {} });
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
  const key = normalizeKey(raw);
  console.log('\n> ' + raw);
  try {
    const r = await runOne(raw);
    const entry = {
      kind: r.kind, images: r.images || [], play: r.play || '', cover: r.cover || '',
      title: r.title || '', via: r.via || '', platform: r.platform, engine: ENGINE_VERSION, ts: r.ts,
    };
    writeLight(raw, { key, ok: true, data: r, engine: ENGINE_VERSION, ts: ts() });
    writeCache(key, '', entry);
    okN++;
    const n = r.kind === 'profile' ? (r.items?.length || 0) : (r.images?.length || 1);
    console.log(`  OK ${r.kind} ×${n} · ${r.via}`);
    lines.push(`| OK | ${r.platformName} | ${n} | ${r.via} |`);
  } catch (e) {
    const error = { code: e.code || 'UNKNOWN', message: String(e.message || e).slice(0, 200) };
    const prior = readCache().entries[key];
    /* 之前成功过就别用失败覆盖；轻量文件里回吐旧结果，前端立刻能出图 */
    if (prior && !prior.err) {
      writeLight(raw, {
        key, ok: true, cached: true,
        data: { ...prior, kind: prior.kind, images: prior.images || [], play: prior.play || '', cover: prior.cover || '', title: prior.title || '' },
        engine: ENGINE_VERSION, ts: ts(),
      });
      console.log('  KEEP 已有成功缓存，本次失败不覆盖（' + error.message + '）');
      lines.push('| CACHED | - | - | 本次失败，回吐旧结果 |');
      okN++;
    } else {
      writeLight(raw, { key, ok: false, error, engine: ENGINE_VERSION, ts: ts() });
      writeCache(key, '', { err: error.message, code: error.code, engine: ENGINE_VERSION, ts: ts() });
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
