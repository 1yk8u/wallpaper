'use strict';
/* =====================================================================
 * parser/bili-fingerprint.mjs —— B站指纹池生成器
 *
 * 背景：B站对无指纹的 CDN 直链请求返回 403/-412。带上一套新鲜指纹
 * （buvid3 + b_nut）后，实测直链可从 403 变 200。但指纹会随时间失效，
 * 所以每天定时领一批新指纹存进 data/bili-fingerprints.json，解析时轮换使用。
 *
 * 运行：node parser/bili-fingerprint.mjs
 * 产出：data/bili-fingerprints.json
 *   { updated, count, fingerprints:[{ cookie, buvid3, at }, ...] }
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'bili-fingerprints.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BATCH = 12;        // 每天领 12 套，轮换用
const KEEP = 40;         // 池子最多保留 40 套（约 3 天量），防止无限膨胀
const NAMES = ['buvid3', 'buvid4', 'b_nut', 'b_lsid', 'bili_ticket'];

function pickCookies(setCookieText) {
  const out = [];
  for (const n of NAMES) {
    const m = setCookieText.match(new RegExp('(?:^|,\\s*|;\\s*)' + n + '=([^;,]+)'));
    if (m) out.push(n + '=' + m[1].trim());
  }
  return out.join('; ');
}

async function grabOne() {
  const r = await fetch('https://www.bilibili.com/', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  });
  const arr = r.headers.getSetCookie
    ? r.headers.getSetCookie()
    : [r.headers.get('set-cookie') || ''];
  const cookie = pickCookies(arr.join('; '));
  if (!/buvid3=/.test(cookie)) return null;
  const b3 = (cookie.match(/buvid3=([^;]+)/) || [])[1] || '';
  return { cookie, buvid3: b3, at: new Date().toISOString() };
}

async function collect(n) {
  const fresh = [];
  for (let i = 0; i < n; i++) {
    try {
      const fp = await grabOne();
      if (fp && !fresh.some(x => x.buvid3 === fp.buvid3)) fresh.push(fp);
      console.log(`  领第 ${i + 1}/${n} 套: ${fp ? fp.buvid3.slice(0, 12) + '…' : '失败'}`);
    } catch (e) {
      console.log(`  领第 ${i + 1}/${n} 套失败: ${String(e.message || e).slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return fresh;
}

function save(fresh) {
  // 合并旧池：新的排前面，旧的后备，按 buvid3 去重，保留最近 KEEP 套
  let old = [];
  try {
    const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (Array.isArray(j.fingerprints)) old = j.fingerprints;
  } catch (e) { /* 首次运行没有旧文件 */ }
  const seen = new Set();
  const merged = [];
  for (const fp of [...fresh, ...old]) {
    if (fp && fp.cookie && !seen.has(fp.buvid3)) {
      seen.add(fp.buvid3);
      merged.push(fp);
    }
  }
  const final = merged.slice(0, KEEP);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    count: final.length,
    fingerprints: final,
  }, null, 2));
  return final.length;
}

/** 被 engine.mjs 调用：池子过期时补一批（静默模式，不设 exitCode） */
export async function restock() {
  try {
    const fresh = await collect(6);
    const total = save(fresh);
    console.log(`[bili-fp] 自动补货完成：新增 ${fresh.length} 套，池内 ${total} 套`);
  } catch (e) { console.log('[bili-fp] 自动补货失败:', String(e.message || e).slice(0, 80)); }
}

async function main() {
  const fresh = await collect(BATCH);
  const total = save(fresh);
  console.log(`完成：本次新增 ${fresh.length} 套，池内共 ${total} 套 → ${OUT}`);
  if (!fresh.length) {
    console.error('警告：本次一套都没领到（可能被风控），保留旧池');
    process.exitCode = 1;
  }
}

/* 直接运行（node parser/bili-fingerprint.mjs）才批量刷新；
 * 被 import 时只导出 restock，不自动执行，避免解析时重复领一批。 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
