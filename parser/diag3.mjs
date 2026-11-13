#!/usr/bin/env node
/* 深挖 _ROUTER_DATA：用手机 UA 抓 iesdouyin 分享页，解析内嵌 JSON */
'use strict';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const DY_ID = process.env.DY_ID || '7640539094375909881';

function decodeJson(str) {
  try { return JSON.parse(str); } catch {}
  try { return JSON.parse(str.replace(/\\u002F/g, '/').replace(/\\\//g, '/')); } catch {}
  return null;
}

function findAllURLs(obj, path = '') {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => results.push(...findAllURLs(v, path + '[' + i + ']')));
    return results;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k;
    if (typeof v === 'string' && /https?:\/\//.test(v)) {
      results.push({ path: p, url: v.replace(/\\u002F/g, '/').replace(/\\\//g, '/') });
    } else if (typeof v === 'object') {
      results.push(...findAllURLs(v, p));
    }
  }
  return results;
}

function findStringValue(obj, key, path = '') {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => results.push(...findStringValue(v, key, path + '[' + i + ']')));
    return results;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k;
    if (k === key && typeof v === 'string') results.push({ path: p, value: v });
    else if (typeof v === 'object') results.push(...findStringValue(v, key, p));
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

async function main() {
  console.log('='.repeat(70));
  console.log('深挖 _ROUTER_DATA · ' + new Date().toISOString());
  console.log('='.repeat(70));

  // 测试1：手机 UA 分享页
  console.log('\n【测试1】手机 UA · iesdouyin 分享页');
  const r1 = await fetchPage(`https://www.iesdouyin.com/share/video/${DY_ID}`, UA_MOBILE);
  console.log(`  HTTP ${r1.status} · ${r1.text.length} 字节 · 跳转到: ${r1.finalUrl.slice(0, 100)}`);

  // 提取 _ROUTER_DATA
  const rdMatch = r1.text.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (rdMatch) {
    console.log('  ✅ 找到 _ROUTER_DATA，长度', rdMatch[1].length, '字符');
    const rd = decodeJson(rdMatch[1]);
    if (rd) {
      console.log('  ✅ JSON 解析成功');

      // 顶层结构
      console.log('\n  顶层键:', Object.keys(rd));
      if (rd.loaderData) {
        console.log('  loaderData 键:', Object.keys(rd.loaderData));
        for (const [k, v] of Object.entries(rd.loaderData)) {
          if (v && typeof v === 'object') {
            console.log(`    "${k}" → 子键: ${Object.keys(v).slice(0, 15).join(', ')}`);
          }
        }
      }

      // 深度搜索所有 URL
      const allUrls = findAllURLs(rd);
      console.log(`\n  所有 URL 共 ${allUrls.length} 条:`);
      for (const { path, url } of allUrls.slice(0, 30)) {
        console.log(`    [${path}]`);
        console.log(`      ${url.slice(0, 180)}`);
      }

      // 搜索关键字段
      for (const key of ['playAddr', 'play_addr', 'playApi', 'playApiUrl', 'url_list', 'playUrl', 'downloadUrl', 'videoUrl', 'src', 'desc', 'title', 'nickname', 'cover']) {
        const vals = findStringValue(rd, key);
        if (vals.length) {
          console.log(`\n  字段 "${key}" (${vals.length} 处):`);
          vals.slice(0, 3).forEach(v => console.log(`    [${v.path}] ${String(v.value).slice(0, 180)}`));
        }
      }
    } else {
      console.log('  ❌ JSON 解析失败，原始片段:');
      console.log('  ' + rdMatch[1].slice(0, 500));
    }
  } else {
    console.log('  ❌ 未找到 _ROUTER_DATA');
    // 尝试宽松匹配
    const idx = r1.text.indexOf('_ROUTER_DATA');
    if (idx >= 0) {
      console.log('  但文本中存在 _ROUTER_DATA @ ' + idx);
      console.log('  上下文: ' + r1.text.slice(idx - 20, idx + 300).replace(/\s+/g, ' '));
    }
  }

  // 提取 _SSR_DATA
  const sdMatch = r1.text.match(/window\._SSR_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (sdMatch) {
    console.log('\n  ✅ 找到 _SSR_DATA，长度', sdMatch[1].length);
    const sd = decodeJson(sdMatch[1]);
    if (sd) {
      console.log('  顶层键:', Object.keys(sd));
      const sdUrls = findAllURLs(sd);
      console.log(`  SSR_DATA 中 URL: ${sdUrls.length} 条`);
      sdUrls.slice(0, 10).forEach(({ path, url }) => console.log(`    [${path}] ${url.slice(0, 150)}`));
    }
  }

  // 测试2：手机 UA 对比 PC UA 页面大小
  console.log('\n【测试2】对比 PC UA 分享页');
  const r2 = await fetchPage(`https://www.iesdouyin.com/share/video/${DY_ID}`, UA_PC);
  console.log(`  HTTP ${r2.status} · ${r2.text.length} 字节 (PC UA) vs ${r1.text.length} 字节 (手机 UA)`);

  // 测试3：图集 ID 的手机 UA 页面
  console.log('\n【测试3】手机 UA · slides 分享页（图集）');
  const r3 = await fetchPage(`https://www.iesdouyin.com/share/slides/${DY_ID}`, UA_MOBILE);
  console.log(`  HTTP ${r3.status} · ${r3.text.length} 字节`);
  const rd3 = r3.text.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (rd3) {
    console.log('  ✅ 找到 _ROUTER_DATA');
    const d3 = decodeJson(rd3[1]);
    if (d3) {
      const urls3 = findAllURLs(d3);
      console.log(`  URL 数: ${urls3.length}`);
      urls3.slice(0, 10).forEach(({ path, url }) => console.log(`    [${path}] ${url.slice(0, 150)}`));
    }
  }

  // 测试4：快手手机 UA
  console.log('\n【测试4】快手移动页（手机 UA）');
  const r4 = await fetchPage('https://v.m.chenzhongtech.com/fw/photo/3xf8uw3n8e7i8g8', UA_MOBILE).catch(e => ({ status: 0, text: '', finalUrl: '', err: e.message }));
  console.log(`  HTTP ${r4.status} · ${r4.text ? r4.text.length : 0} 字节`);
  if (r4.text) {
    const ksData = r4.text.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/) || r4.text.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
    if (ksData) {
      console.log('  ✅ 找到内嵌数据');
      const d4 = decodeJson(ksData[1]);
      if (d4) {
        const urls4 = findAllURLs(d4);
        console.log(`  URL 数: ${urls4.length}`);
        urls4.slice(0, 10).forEach(({ path, url }) => console.log(`    [${path}] ${url.slice(0, 150)}`));
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('完成');
}

main().catch(e => { console.error('异常:', e); process.exit(1); });
