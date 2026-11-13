#!/usr/bin/env node
/* 深挖诊断：抓取抖音页面完整 HTML，分析内嵌数据结构
 * 目标：找出美国 IP 下 SSR 页面里可提取的图片/视频直链
 */
'use strict';

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

const DY_ID = process.env.DY_ID || '7640539094375909881';

async function fetchText(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_PC, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, len: text.length, text, finalUrl: res.url };
  } catch (e) {
    return { status: 0, len: 0, text: '', err: String(e.message || e).slice(0, 100) };
  }
}

function analyze(name, r) {
  console.log('\n' + '='.repeat(70));
  console.log(`【${name}】HTTP ${r.status} · ${r.len} 字节`);
  if (r.err) { console.log('  错误:', r.err); return; }
  if (r.finalUrl && r.finalUrl !== r.text) console.log('  最终URL:', r.finalUrl.slice(0, 120));

  const t = r.text;

  // 1. 找内嵌数据脚本
  const dataMarkers = ['_ROUTER_DATA', 'RENDER_DATA', '__INIT_PROPS__', '_SSR_DATA', 'INITIAL_STATE', 'window.__data', 'SSR_HYDRATED_DATA', '__NEXT_DATA__', 'playApi', 'itemInfo', 'awemeDetail'];
  for (const mk of dataMarkers) {
    const idx = t.indexOf(mk);
    if (idx >= 0) {
      console.log(`  ✅ 发现数据标记 "${mk}" @ 位置 ${idx}`);
      console.log(`     上下文: …${t.slice(Math.max(0, idx - 30), idx + 120).replace(/\s+/g, ' ')}…`);
    }
  }

  // 2. 找所有 script 标签
  const scripts = t.match(/<script[^>]*>/gi) || [];
  console.log(`  script 标签数: ${scripts.length}`);

  // 3. 找图片直链
  const imgPats = [
    /https?:\/\/[^\s"'<>\\]*(?:douyinpic|p\d+-pc-sign|p\d+-sign|p\d+-xs-sign|sns-webpic|byteimg)[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.jpe?g[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.webp[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.png[^\s"'<>\\]*/gi,
  ];
  const imgs = new Set();
  for (const p of imgPats) for (const m of t.match(p) || []) imgs.add(m.slice(0, 180));
  const imgArr = [...imgs];
  console.log(`  图片类 URL: ${imgArr.length} 条`);
  imgArr.slice(0, 5).forEach(u => console.log(`    → ${u}`));

  // 4. 找视频直链
  const vidPats = [
    /https?:\/\/[^\s"'<>\\]*douyinvod[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.mp4[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*(playwm|play_addr|video_id=)[^\s"'<>\\]*/gi,
  ];
  const vids = new Set();
  for (const p of vidPats) for (const m of t.match(p) || []) vids.add(m.slice(0, 180));
  const vidArr = [...vids];
  console.log(`  视频类 URL: ${vidArr.length} 条`);
  vidArr.slice(0, 3).forEach(u => console.log(`    → ${u}`));

  // 5. 找 og/meta
  const ogTitle = (t.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/) || [])[1];
  const ogDesc = (t.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/) || [])[1];
  const ogImg = (t.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/) || [])[1];
  const ogVideo = (t.match(/<meta[^>]*property="og:(?:video|video:url)"[^>]*content="([^"]*)"/) || [])[1];
  if (ogTitle) console.log(`  og:title = ${ogTitle.slice(0, 80)}`);
  if (ogDesc) console.log(`  og:description = ${ogDesc.slice(0, 80)}`);
  if (ogImg) console.log(`  og:image = ${ogImg.slice(0, 120)}`);
  if (ogVideo) console.log(`  og:video = ${ogVideo.slice(0, 120)}`);

  // 6. 找 url_list
  const ul = t.match(/"url_list"\s*:\s*\[([^\]]{10,5000})\]/);
  if (ul) {
    const urls = (ul[1].match(/https?:\/\/[^\s"'\\]+/g) || []).map(u => u.replace(/\\u002F/g, '/').replace(/\\\//g, '/'));
    console.log(`  ✅ url_list 数组: ${urls.length} 条`);
    urls.slice(0, 5).forEach(u => console.log(`    → ${u}`));
  }

  // 7. JSON 块统计
  const jsonBlocks = t.match(/\{[^{}]{50,}\}/g) || [];
  console.log(`  疑似 JSON 块: ${jsonBlocks.length} 个`);
  if (jsonBlocks.length) {
    jsonBlocks.slice(0, 2).forEach((b, i) => console.log(`    [${i}] ${b.slice(0, 150).replace(/\s+/g, ' ')}…`));
  }

  // 8. 判断页面类型
  if (t.length < 3000) console.log('  📄 纯前端壳（SPA shell）');
  else if (t.includes('_ROUTER_DATA') || t.includes('RENDER_DATA') || t.includes('__INIT_PROPS__')) console.log('  📄 含内嵌数据的 SSR 页');
  else console.log('  📄 普通 HTML（无明显内嵌数据）');
}

async function main() {
  console.log('深挖诊断 · 时间', new Date().toISOString());
  let ip = '?';
  try { ip = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch {}
  console.log('出口 IP:', ip);

  const tests = [
    { name: '① 视频分享页 (PC UA)', url: `https://www.iesdouyin.com/share/video/${DY_ID}` },
    { name: '② 图集分享页 slides', url: `https://www.iesdouyin.com/share/slides/${DY_ID}` },
    { name: '③ 主站 note 页', url: `https://www.douyin.com/note/${DY_ID}` },
    { name: '④ 主站 video 页', url: `https://www.douyin.com/video/${DY_ID}` },
    { name: '⑤ 分享页手机 UA', url: `https://www.iesdouyin.com/share/video/${DY_ID}`, headers: { 'User-Agent': UA_MOBILE } },
    { name: '⑥ share/video 带参数', url: `https://www.iesdouyin.com/share/video/${DY_ID}?iid=7300000000000000000&mid=7300000000000000000&sec_uid=&previous_page=web_code_link` },
  ];

  for (const t of tests) {
    const r = await fetchText(t.url, t.headers || {});
    analyze(t.name, r);
    await new Promise(s => setTimeout(s, 500));
  }

  console.log('\n' + '='.repeat(70));
  console.log('深挖诊断完成');
}

main().catch(e => { console.error('异常:', e); process.exit(1); });
