'use strict';
/* =====================================================================
 * parser/serve.mjs —— 本地解析服务（自己写的解析工具，零依赖）
 *
 *   node parser/serve.mjs                 # 只监听 127.0.0.1:8787（推荐）
 *   HOST=0.0.0.0 PORT=8787 node parser/serve.mjs   # 允许同一局域网的手机访问
 *
 * 目的：GitHub Actions 的境外 IP 常被国内平台风控（B 站 -412 / 抖音验证码），
 * 而你自己的电脑在国内网络里跑同一个引擎就没有这个问题。
 * 网站「解析」页 → 高级 → 填入 http://127.0.0.1:8787 即可秒出结果。
 *
 * 接口：
 *   GET /health                      → { ok, engine, now }
 *   GET /parse?url=<链接>[&profile=1] → 引擎统一结果，或 { ok:false, error }
 * 只读取链接、不写任何文件；不要把它直接暴露到公网。
 * ===================================================================== */
import http from 'node:http';
import os from 'node:os';
import { parse, ENGINE_VERSION } from './engine.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  /* Chrome 从 HTTPS 页面访问本机服务时要求这个头 */
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
}
function send(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (u.pathname === '/health') {
    send(res, 200, { ok: true, engine: ENGINE_VERSION, now: new Date().toISOString() });
    return;
  }

  if (u.pathname === '/parse') {
    const url = u.searchParams.get('url') || '';
    if (!url) { send(res, 400, { ok: false, error: { code: 'STRUCT', message: '缺少 url 参数' } }); return; }
    console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + url.slice(0, 120));
    try {
      const data = await parse(url, { profile: u.searchParams.get('profile') === '1' });
      console.log('  OK ' + data.kind + ' · ' + data.via);
      send(res, 200, { ok: true, data });
    } catch (e) {
      console.log('  FAIL ' + (e.code || '') + ' ' + (e.message || e));
      send(res, 200, { ok: false, error: { code: e.code || 'UNKNOWN', message: String(e.message || e) } });
    }
    return;
  }

  if (u.pathname === '/') {
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>壁纸库 · 本地解析引擎</title>
<style>body{font:15px/1.8 system-ui,"Microsoft YaHei",sans-serif;max-width:680px;margin:8vh auto;padding:0 20px;color:#2c3324;background:#faf8f2}
code{background:#ece8dc;padding:2px 6px;border-radius:5px}h1{font-size:24px}.ok{color:#4c7a2f}</style>
<h1>壁纸库 · 本地解析引擎 <span class="ok">运行中</span></h1>
<p>引擎版本 ${ENGINE_VERSION}，跑在你自己的电脑上，用自己的网络直连各平台，不走任何第三方解析接口。</p>
<p>在壁纸站「解析」页 → <b>高级 · 本地解析引擎</b>，填入：<br><code>http://127.0.0.1:${PORT}</code></p>
<p>想让同一 Wi-Fi 下的手机也能用：用 <code>HOST=0.0.0.0 node parser/serve.mjs</code> 启动，再填电脑的局域网地址（注意手机浏览器对 http 页面的限制）。</p>
<p>接口：<code>GET /health</code> · <code>GET /parse?url=链接</code></p>`);
    return;
  }
  send(res, 404, { ok: false, error: { code: 'STRUCT', message: '未知路径' } });
});

server.listen(PORT, HOST, () => {
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter(x => x && x.family === 'IPv4' && !x.internal).map(x => x.address);
  console.log('壁纸库自研解析引擎 v' + ENGINE_VERSION + ' 已启动');
  console.log('  本机：   http://' + HOST + ':' + PORT);
  if (HOST === '0.0.0.0' && nets.length) console.log('  局域网： ' + nets.map(ip => 'http://' + ip + ':' + PORT).join('  '));
  console.log('  在网站「解析 → 高级」里填入上面的地址；Ctrl+C 停止');
});
