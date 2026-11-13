#!/usr/bin/env node
/* 深挖大响应：分析快手 97KB 移动页 + 抖音 72KB 页面中的数据结构 */
'use strict';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const DY_ID = process.env.DY_ID || '7640539094375909881';
const KS_ID = process.env.KS_ID || '3xf8uw3n8e7i8g8'; // 示例快手 ID

function decodeJson(str) {
  try { return JSON.parse(str); } catch {}
  try { return JSON.parse(str.replace(/\\u002F/g, '/').replace(/\\\//g, '/')); } catch {}
  return null;
}

function findAllURLs(obj, path = '', depth = 0) {
  const results = [];
  if (!obj || typeof obj !== 'object' || depth > 8) return results;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => results.push(...findAllURLs(v, path + '[' + i + ']', depth + 1)));
    return results;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k;
    if (typeof v === 'string' && /https?:\/\//.test(v)) {
      results.push({ path: p, url: v.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&') });
    } else if (typeof v === 'object') {
      results.push(...findAllURLs(v, p, depth + 1));
    }
  }
  return results;
}

function findKeys(obj, targetKeys, path = '', depth = 0, results = []) {
  if (!obj || typeof obj !== 'object' || depth > 8) return results;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findKeys(v, targetKeys, path + '[' + i + ']', depth + 1, results));
    return results;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k;
    if (targetKeys.some(tk => k.toLowerCase().includes(tk.toLowerCase()))) {
      results.push({ path: p, key: k, value: typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200) });
    }
    if (typeof v === 'object') findKeys(v, targetKeys, p, depth + 1, results);
  }
  return results;
}

async function fetchPage(url, ua) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, text: await res.text(), finalUrl: res.url };
}

function extractScriptData(html) {
  const scripts = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const content = m[1].trim();
    if (content.length > 50 && content.length < 500000) {
      scripts.push(content);
    }
  }
  return scripts;
}

async function analyzePage(name, url, ua) {
  console.log('\n' + '='.repeat(70));
  console.log(`【${name}】`);
  const r = await fetchPage(url, ua);
  console.log(`  HTTP ${r.status} · ${r.text.length} 字节 · 跳转: ${r.finalUrl.slice(0, 100)}`);

  const t = r.text;
  const scripts = extractScriptData(t);
  console.log(`  script 块: ${scripts.length} 个`);

  // 找所有 window.__XXX = {...} 赋值
  const windowAssigns = [];
  for (const s of scripts) {
    const m = s.match(/window\.(\w+)\s*=\s*(\{[\s\S]{20,}?)/);
    if (m) {
      const name = m[1];
      // 尝试找到完整的 JSON
      const jsonStr = m[2];
      windowAssigns.push({ name, preview: jsonStr.slice(0, 200), len: jsonStr.length });
    }
  }
  if (windowAssigns.length) {
    console.log(`  window 赋值: ${windowAssigns.length} 个`);
    windowAssigns.forEach(w => console.log(`    window.${w.name} = … (${w.len} chars) ${w.preview.slice(0, 100)}…`));
  }

  // 找所有包含 URL 的 script 块
  for (let i = 0; i < scripts.length; i++) {
    const s = scripts[i];
    const urls = s.match(/https?:\/\/[^\s"'<>\\]{20,}/g) || [];
    const mediaUrls = urls.filter(u => /\.(mp4|m3u8|jpe?g|png|webp|gif)|douyinvod|yximgs|kwimgs|chenzhongtech|sns-video|play_addr|playAddr/i.test(u));
    if (mediaUrls.length) {
      console.log(`  ✅ script[${i}] 含媒体 URL ${mediaUrls.length} 条 (总长 ${s.length}):`);
      mediaUrls.slice(0, 5).forEach(u => console.log(`    → ${u.slice(0, 180)}`));
    }
    // 检查是否是大 JSON 块
    if (s.length > 2000 && s.includes('{')) {
      const jsonM = s.match(/(\{[\s\S]+\})/);
      if (jsonM) {
        const j = decodeJson(jsonM[1]);
        if (j) {
          const allUrls = findAllURLs(j);
          const mediaU = allUrls.filter(u => /\.(mp4|m3u8|jpe?g|png|webp|gif)|douyinvod|yximgs|kwimgs|chenzhongtech|sns-video|play/i.test(u.url));
          if (mediaU.length) {
            console.log(`  ✅ script[${i}] JSON 含媒体 URL ${mediaU.length} 条:`);
            mediaU.slice(0, 5).forEach(u => console.log(`    [${u.path}] ${u.url.slice(0, 180)}`));
          }
        }
      }
    }
  }

  // 宽模式搜索页面中的媒体 URL
  const allMediaPats = [
    /https?:\/\/[^\s"'<>\\]*douyinvod[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.mp4[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.m3u8[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*(?:yximgs|kwimgs|chenzhongtech|sns-video)[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*(?:play_addr|playAddr|playApi|playUrl)[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.(?:jpe?g|png|webp)[^\s"'<>\\]*/gi,
  ];
  const allMedia = new Set();
  for (const p of allMediaPats) {
    for (const m of t.match(p) || []) {
      const u = m.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (u.length > 30) allMedia.add(u.slice(0, 200));
    }
  }
  console.log(`  页面所有媒体 URL: ${allMedia.size} 条`);
  [...allMedia].slice(0, 10).forEach(u => console.log(`    → ${u}`));

  // 找 JSON 数据块中关键字
  const keySearch = findKeys(decodeJson(t.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)?.[1] || '{}'),
    ['play', 'video', 'url', 'src', 'cover', 'image', 'photo', 'desc', 'title', 'caption']);
  if (keySearch.length) {
    console.log(`  _ROUTER_DATA 关键字段: ${keySearch.length} 处`);
    keySearch.slice(0, 10).forEach(k => console.log(`    [${k.path}] ${k.key} = ${k.value}`));
  }

  return r.text;
}

async function main() {
  console.log('大响应深挖 · ' + new Date().toISOString());
  let ip = '?';
  try { ip = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch {}
  console.log('出口 IP:', ip);

  // 快手移动页（97KB）
  await analyzePage('快手移动分享页', `https://v.m.chenzhongtech.com/fw/photo/${KS_ID}`, UA_MOBILE);
  await new Promise(s => setTimeout(s, 500));

  // 快手移动页（PC UA 对比）
  await analyzePage('快手移动分享页 (PC UA)', `https://v.m.chenzhongtech.com/fw/photo/${KS_ID}`, UA_PC);
  await new Promise(s => setTimeout(s, 500));

  // 抖音分享页（PC UA，可能拿到 72KB）
  await analyzePage('抖音分享页 (PC UA)', `https://www.iesdouyin.com/share/video/${DY_ID}`, UA_PC);
  await new Promise(s => setTimeout(s, 500));

  // 抖音分享页（手机 UA）
  await analyzePage('抖音分享页 (手机 UA)', `https://www.iesdouyin.com/share/video/${DY_ID}`, UA_MOBILE);

  console.log('\n' + '='.repeat(70));
  console.log('完成');
}

main().catch(e => { console.error('异常:', e); process.exit(1); });
