#!/usr/bin/env node
/* 诊断：从当前出口 IP 测试抖音/快手各备用解析通道
 * 目标：找出美国 IP 下仍能拿到直链的接口，替代整浏览器渲染
 * 用法：DY_ID=xxx node parser/diag.mjs
 */
'use strict';

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

const DY_ID = process.env.DY_ID || '7640539094375909881';
const KS_ID = process.env.KS_ID || '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, headers = {}, method = 'GET') {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA_PC,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, len: text.length, text, ms: Date.now() - t0, finalUrl: res.url };
  } catch (e) {
    return { status: 0, len: 0, text: '', ms: Date.now() - t0, err: String(e.message || e).slice(0, 120) };
  }
}

/* 从文本里捞视频直链 */
function findVideoURLs(text) {
  const patterns = [
    /https?:\/\/[^\s"'<>\\]*douyinvod[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*\.mp4[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*(playwm|playaddr|play_addr|video_id=)[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]*(kwimgs|yximgs|chenzhongtech)[^\s"'<>\\]*(mp4|m3u8|play)[^\s"'<>\\]*/gi,
  ];
  const found = new Set();
  for (const p of patterns) {
    for (const m of text.match(p) || []) {
      const u = m.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      if (u.length > 30) found.add(u.slice(0, 200));
    }
  }
  return [...found];
}

/* 从文本里捞 JSON 中的 url_list */
function findUrlList(text) {
  const m = text.match(/"url_list"\s*:\s*\[([^\]]{10,3000})\]/);
  if (!m) return [];
  return (m[1].match(/https?:\/\/[^\s"'\\]+/g) || []).map(u => u.replace(/\\u002F/g, '/').replace(/\\\//g, '/')).slice(0, 5);
}

function judge(text) {
  const head = text.replace(/\s+/g, ' ').slice(0, 3000);
  if (/安全验证|滑动验证|verify|captcha|安全中心|风控|slide|人机验证|异常访问/i.test(head)) return '疑似风控/验证页';
  if (/登录|login|passport|二维码登录/i.test(head) && text.length < 30000) return '疑似登录墙';
  if (text.length < 3000) return '内容过短';
  return '正常响应';
}

async function main() {
  console.log('='.repeat(60));
  console.log('解析通道诊断 · 时间', new Date().toISOString());
  let ip = '未知';
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
    ip = (await r.json()).ip;
  } catch (e) { /* ignore */ }
  console.log('出口 IP:', ip);
  console.log('目标抖音 ID:', DY_ID, KS_ID ? '· 快手 ID: ' + KS_ID : '');
  console.log('='.repeat(60));

  const tests = [
    {
      name: '① 抖音分享页 iesdouyin (PC UA)',
      url: `https://www.iesdouyin.com/share/video/${DY_ID}`,
    },
    {
      name: '② 抖音分享页 iesdouyin (手机 UA)',
      url: `https://www.iesdouyin.com/share/video/${DY_ID}`,
      headers: { 'User-Agent': UA_MOBILE },
    },
    {
      name: '③ 抖音旧API iteminfo',
      url: `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${DY_ID}`,
      headers: { 'Accept': 'application/json' },
    },
    {
      name: '④ 抖音Web详情API aweme/detail',
      url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${DY_ID}`,
      headers: {
        'Accept': 'application/json',
        'Referer': `https://www.douyin.com/video/${DY_ID}`,
      },
    },
    {
      name: '⑤ 抖音移动API aweme/detail (android UA)',
      url: `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${DY_ID}`,
      headers: {
        'User-Agent': UA_ANDROID,
        'Accept': 'application/json',
        'Referer': `https://www.douyin.com/video/${DY_ID}`,
      },
    },
    {
      name: '⑥ 抖音主站页面 (PC UA)',
      url: `https://www.douyin.com/video/${DY_ID}`,
    },
    {
      name: '⑦ 抖音主站页面 (手机 UA)',
      url: `https://www.douyin.com/video/${DY_ID}`,
      headers: { 'User-Agent': UA_MOBILE },
    },
    {
      name: '⑧ 抖音图集分享页',
      url: `https://www.iesdouyin.com/share/slides/${DY_ID}`,
    },
    {
      name: '⑨ iesdouyin 首页(连通性)',
      url: 'https://www.iesdouyin.com/',
    },
    {
      name: '⑩ douyin 主站(连通性)',
      url: 'https://www.douyin.com/',
    },
  ];

  const results = [];
  for (const t of tests) {
    process.stdout.write(`\n【${t.name}】\n  请求中…`);
    const r = await fetchText(t.url, t.headers || {});
    const vids = findVideoURLs(r.text);
    const urlList = findUrlList(r.text);
    const verdict = r.err ? '请求失败: ' + r.err : judge(r.text);
    console.log(`\r  状态: HTTP ${r.status} · ${r.len} 字节 · ${r.ms}ms · ${verdict}`);
    if (r.finalUrl && r.finalUrl !== t.url) console.log(`  跳转到: ${r.finalUrl.slice(0, 100)}`);
    if (vids.length) {
      console.log(`  ✅ 命中视频直链 ${vids.length} 条:`);
      vids.slice(0, 3).forEach(v => console.log(`    → ${v}`));
    }
    if (urlList.length) {
      console.log(`  ✅ 命中 url_list ${urlList.length} 条:`);
      urlList.slice(0, 3).forEach(v => console.log(`    → ${v}`));
    }
    if (!vids.length && !urlList.length && r.len > 0 && r.len < 5000) {
      console.log(`  片段: ${r.text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    results.push({ name: t.name, status: r.status, len: r.len, verdict, videoCount: vids.length, urlListCount: urlList.length });
    await sleep(600);
  }

  if (KS_ID) {
    console.log('\n' + '='.repeat(60));
    console.log('快手补充测试');
    const ksTests = [
      { name: '快手移动分享页', url: `https://v.m.chenzhongtech.com/fw/photo/${KS_ID}` },
      { name: '快手移动分享页(手机UA)', url: `https://v.m.chenzhongtech.com/fw/photo/${KS_ID}`, headers: { 'User-Agent': UA_MOBILE } },
    ];
    for (const t of ksTests) {
      const r = await fetchText(t.url, t.headers || {});
      const vids = findVideoURLs(r.text);
      console.log(`\n【${t.name}】HTTP ${r.status} · ${r.len} 字节 · ${r.ms}ms`);
      if (vids.length) { console.log(`  ✅ 直链 ${vids.length} 条`); vids.slice(0, 2).forEach(v => console.log(`    → ${v}`)); }
      else console.log(`  ${judge(r.text)}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('汇总：');
  console.table(results);
  const usable = results.filter(r => r.videoCount > 0 || r.urlListCount > 0);
  console.log(usable.length
    ? `🎯 找到 ${usable.length} 条可用通道：${usable.map(r => r.name).join('、')}`
    : '⚠️ 当前 IP 下所有直链通道均被拦（预期：美国 IP 会被抖音/快手风控）');
  console.log('='.repeat(60));
}

main().catch(e => { console.error('诊断脚本异常:', e); process.exit(1); });
