'use strict';
/* =====================================================================
 * parser/cli.mjs —— 本地解析命令行（自己写的解析工具，零依赖）
 *
 *   node parser/cli.mjs "https://v.douyin.com/xxxxx"
 *   node parser/cli.mjs "链接1" "链接2" --save
 *   node parser/cli.mjs --file links.txt --save
 *   node parser/cli.mjs "https://www.kuaishou.com/profile/xxx" --profile --save
 *   node parser/cli.mjs "链接" --json            # 只输出 JSON
 *   node parser/cli.mjs "链接" --cookie "a=1; b=2"
 *   node parser/cli.mjs --selftest
 *
 * --save 会写两份：
 *   data/parsed/<hash>.json     轻量结果（网页轮询读这个，实时、不受大文件限制）
 *   data/parse-cache.json       总缓存（兼容旧版前端，双 key 写入）
 * 写完 commit + push 即可，网页上再粘贴同一条链接会秒出。
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseMany, extractURL, normalizeKey, resultKey, setCookie, ENGINE_VERSION } from './engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARSED_DIR = path.join(ROOT, 'data', 'parsed');
const CACHE_PATH = path.join(ROOT, 'data', 'parse-cache.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };

function help() {
  console.log(`壁纸库自研解析引擎 v${ENGINE_VERSION}（Node 18+，零依赖）

用法：
  node parser/cli.mjs <链接...> [选项]
  node parser/cli.mjs --file links.txt --save
  node parser/cli.mjs --selftest

选项：
  --save          把结果写进仓库（data/parsed/ + data/parse-cache.json）
  --json          只输出 JSON，不打印中文摘要
  --profile       按「快手主页批量」模式解析
  --cookie <串>   注入自己的登录 cookie（只在本机内存，不写文件）
  --file <路径>   从文本文件读链接（每行一条，# 开头为注释）
  --no-resolve    不还原短链
  --selftest      跑引擎自测（离线 + 联网）
  --help          显示本帮助

支持：抖音 / 快手 / 哔哩哔哩 / 小红书 / 快手主页批量 / 任意网页 / 图片视频直链
不调用任何第三方解析接口。`);
}

function loadURLs() {
  const out = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--file' &&
    argv[argv.indexOf(a) - 1] !== '--cookie');
  const f = val('--file');
  if (f) {
    const p = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
    const txt = fs.readFileSync(p, 'utf8');
    out.push(...txt.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')));
  }
  return [...new Set(out.map(extractURL).filter(Boolean))];
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readCache() {
  try { const j = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); j.entries = j.entries || {}; return j; }
  catch (e) { return { updated: '', engine: ENGINE_VERSION, entries: {} }; }
}

/** 写轻量结果 + 总缓存；短链 key 和还原后的长链 key 都写，避免前后端 key 不一致 */
function saveOne(raw, r, err) {
  ensureDir(PARSED_DIR);
  const key = normalizeKey(extractURL(raw) || raw);
  const file = resultKey(raw) + '.json';
  const payload = err
    ? { key, ok: false, error: err, engine: ENGINE_VERSION, ts: new Date().toISOString() }
    : { key, ok: true, data: r, engine: ENGINE_VERSION, ts: new Date().toISOString() };
  fs.writeFileSync(path.join(PARSED_DIR, file), JSON.stringify(payload, null, 2));

  const cache = readCache();
  if (err) {
    cache.entries[key] = { err: err.message, code: err.code, ts: payload.ts };
  } else {
    const entry = {
      kind: r.kind, images: r.images || [], play: r.play || '', cover: r.cover || '',
      title: r.title || '', items: r.items || undefined, via: r.via || '',
      engine: ENGINE_VERSION, ts: r.ts,
    };
    cache.entries[key] = entry;
    if (r.finalKey && r.finalKey !== key) cache.entries[r.finalKey] = entry;
  }
  cache.updated = payload.ts;
  cache.engine = ENGINE_VERSION;
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  return file;
}

function brief(r) {
  if (r.kind === 'profile') return `主页抓取 ${r.items.length} 个作品（${r.via}）`;
  if (r.kind === 'video') return `视频 · ${r.via}\n    直链：${r.play.slice(0, 150)}`;
  return `图集 ${r.images.length} 张 · ${r.via}\n    首图：${(r.images[0] || '').slice(0, 150)}`;
}

async function main() {
  if (has('--help') || has('-h')) { help(); return; }
  if (has('--selftest')) {
    await import('./selftest.mjs');
    return;
  }
  const cookie = val('--cookie');
  if (cookie) setCookie(cookie);
  const urls = loadURLs();
  if (!urls.length) { help(); console.log('\n没有给链接。'); process.exitCode = 1; return; }

  const save = has('--save');
  const jsonOnly = has('--json');
  const opt = { profile: has('--profile'), noResolve: has('--no-resolve'), log: jsonOnly ? null : (s) => console.log('  ' + s) };
  const results = [];

  for (const u of urls) {
    if (!jsonOnly) console.log('\n> ' + u);
    try {
      const r = await parse(u, opt);
      results.push({ key: normalizeKey(u), ok: true, data: r });
      if (save) saveOne(u, r, null);
      if (!jsonOnly) console.log('  [OK] ' + r.platformName + ' · ' + brief(r));
    } catch (e) {
      const err = { code: e.code || 'UNKNOWN', message: String(e.message || e) };
      results.push({ key: normalizeKey(u), ok: false, error: err });
      if (save) saveOne(u, null, err);
      if (!jsonOnly) console.log('  [FAIL] ' + err.code + ' · ' + err.message);
    }
  }

  if (jsonOnly) console.log(JSON.stringify(results, null, 2));
  else {
    const ok = results.filter(r => r.ok).length;
    console.log(`\n完成：成功 ${ok} / 共 ${results.length}` + (save ? '，结果已写入 data/parsed/ 与 data/parse-cache.json' : '（加 --save 可写进仓库）'));
    if (save) console.log('接下来：git add data/parsed data/parse-cache.json && git commit -m "本地解析入库" && git push');
  }
  if (results.length && !results.some(r => r.ok)) process.exitCode = 1;
}

main().catch(e => { console.error('CLI 出错：', e); process.exitCode = 1; });
