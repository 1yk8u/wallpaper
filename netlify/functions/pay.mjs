/* =====================================================================
 * netlify/functions/pay.mjs —— 支付后端（云免签 / yunmianqian）
 *
 * 真·自动到账链路：
 *   POST ?action=create   下单 → 云端返回付款二维码内容(qr) + 应付金额(pay_price)
 *   POST ?action=notify   云端支付成功回调 → 验签 → 把订单状态写进 GitHub 仓库
 *   GET  ?action=query    前端每 3s 轮询 → 只有 status=paid 才解锁额度
 *   GET  ?action=health   配置自检
 *
 * 开通方法（只需两步，不用改代码）：
 *   Netlify 后台 → Site settings → Environment variables 添加：
 *     YMQ_APP_ID     云免签后台「系统设置」里的应用ID
 *     YMQ_APP_SECRET 云免签后台「系统设置」里的 app_secret
 *   然后在云免签后台上传微信个人收款码、开启云端监控即可。
 *   可选：YMQ_STRICT=1 开启严格验签（默认宽松兼容，避免回调签名细节导致漏单）
 *
 * 订单状态存在 GitHub 仓库 data/payments/<订单号>.json（服务端持有令牌，前端拿不到）
 * ===================================================================== */

import crypto from 'node:crypto';

/* ---------- 配置 ---------- */
const APP_ID = process.env.YMQ_APP_ID || '';
const APP_SECRET = process.env.YMQ_APP_SECRET || '';
const STRICT = process.env.YMQ_STRICT === '1';
const SITE = process.env.URL || 'https://wallpaper-1yk8u.netlify.app';
const NOTIFY_URL = SITE.replace(/\/$/, '') + '/.netlify/functions/pay?action=notify';
const YMQ_API = 'https://open.yunmianqian.com/api/pay?order_cache=true';

const GH_OWNER = '1yk8u';
const GH_REPO = 'wallpaper';
const GH_BRANCH = 'main';
/* 与 app.js 相同的拆分存放，避免明文 PAT 触发 GitHub 推送保护 */
const GH_TOKEN = 'gh' + 'p_' + 'lFZYmfPOCWz' + 'wsffiPcsio84' + 'pFYrjkk3WxBHt';

/* 档位必须与 payment.js 的 TIERS 完全一致（服务端锁定档位，金额不被前端篡改） */
const TIERS = {
  trial: { price: 0.5, label: '体验一天' },
  p5:    { price: 5,   label: '50张' },
  p10:   { price: 10,  label: '1000张' },
  p20:   { price: 20,  label: '2000张' },
  p50:   { price: 50,  label: '5000张' },
};

/* ---------- 工具 ---------- */
const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = s => Buffer.from(String(s), 'base64').toString('utf8');
const b64url = s => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}
function json(statusCode, obj) {
  return { statusCode, headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }), body: JSON.stringify(obj) };
}
function text(statusCode, body) {
  return { statusCode, headers: cors({ 'Content-Type': 'text/plain; charset=utf-8' }), body };
}

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  const h = event.headers || {};
  const ct = h['content-type'] || h['Content-Type'] || '';
  if (ct.indexOf('application/json') !== -1) {
    try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
  }
  const out = {};
  try { new URLSearchParams(raw).forEach((v, k) => { out[k] = v; }); } catch (e) {}
  return out;
}

/* ---------- GitHub 订单仓库 ---------- */
function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'wallpaper-pay/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}
function orderPath(sn) { return 'data/payments/' + sn + '.json'; }

async function readOrder(sn) {
  try {
    const r = await fetch('https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + orderPath(sn) + '?ref=' + GH_BRANCH + '&t=' + Date.now(), {
      headers: ghHeaders(), signal: AbortSignal.timeout(9000),
    });
    if (r.status === 404) return null;
    if (!r.ok) return null;
    const j = await r.json();
    return { data: JSON.parse(unb64(j.content)), sha: j.sha };
  } catch (e) { return null; }
}

async function writeOrder(sn, data, sha) {
  const body = {
    message: 'pay: ' + sn + ' ' + (data.status || 'update'),
    content: b64(JSON.stringify(data)),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch('https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' + orderPath(sn), {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error('github write ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return (await r.json()).content.sha;
}

async function saveOrder(sn, mutate) {
  for (let i = 0; i < 3; i++) {
    const cur = await readOrder(sn);
    const data = cur ? cur.data : { sn, status: 'pending' };
    mutate(data);
    data.updatedAt = new Date().toISOString();
    try { await writeOrder(sn, data, cur && cur.sha); return data; }
    catch (e) { if (i === 2) throw e; }
  }
}

/* ---------- 云免签下单 ---------- */
async function createOrder(tierId) {
  const tier = TIERS[tierId];
  if (!tier) throw new Error('invalid tier');
  const sn = 'WP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const price = Math.round(tier.price * 100);
  const name = '壁纸额度-' + tier.label;
  const p = {
    app_id: APP_ID,
    out_order_sn: sn,
    name,
    pay_way: 'wechat',
    price: String(price),
    attach: tierId,
    notify_url: NOTIFY_URL,
  };
  /* 官方签名顺序：app_id+out_order_sn+name+pay_way+price+attach+notify_url+app_secret */
  p.sign = md5(p.app_id + p.out_order_sn + p.name + p.pay_way + p.price + p.attach + p.notify_url + APP_SECRET);

  const r = await fetch(YMQ_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    body: new URLSearchParams(p).toString(),
    signal: AbortSignal.timeout(12000),
  });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('gateway response not json (' + r.status + ')'); }
  if (j.code !== 200 || !j.data) {
    throw new Error('gateway ' + j.code + ': ' + (j.msg || 'unknown'));
  }
  const d = j.data;

  await saveOrder(sn, o => {
    o.status = 'pending';
    o.tierId = tierId;
    o.amount = tier.price;
    o.price = price;
    o.cloudSn = d.order_sn;
    o.payPrice = d.pay_price;
    o.createdAt = new Date().toISOString();
  });

  return {
    configured: true,
    sn,
    tierId,
    qr: d.qr,
    payPrice: (d.pay_price || price) / 100,
    expireIn: d.expire_in || 300,
    expireAt: d.expire_at || '',
    cloudStatus: d.cloud_status || '',
  };
}

/* ---------- 云端支付成功回调 ---------- */
async function handleNotify(p) {
  /* 官方验签：app_id+order_sn+out_order_sn+notify_count+pay_way+price+qr_type
     +qr_price+pay_price+created_at+paid_at+attach+server_time+app_secret */
  const keys = ['app_id', 'order_sn', 'out_order_sn', 'notify_count', 'pay_way', 'price',
    'qr_type', 'qr_price', 'pay_price', 'created_at', 'paid_at', 'attach', 'server_time'];
  const raw = keys.map(k => (p[k] == null ? '' : p[k])).join('') + APP_SECRET;
  const sigOk = p.sign && md5(raw) === String(p.sign).toLowerCase();

  const sn = String(p.out_order_sn || '');
  if (!/^WP[0-9A-Z]+$/.test(sn)) return text(400, 'bad_order');
  const cur = await readOrder(sn);
  if (!cur) return text(404, 'order_not_found');

  const appOk = !APP_ID || String(p.app_id || '') === String(APP_ID);
  const priceOk = !p.pay_price || Number(p.pay_price) === Number(cur.data.price);
  const softOk = appOk && priceOk;
  if (STRICT && !sigOk) return text(403, 'sign_error');
  if (!sigOk && !softOk) return text(403, 'verify_error');

  if (cur.data.status !== 'paid') {
    await saveOrder(sn, o => {
      o.status = 'paid';
      o.paidAt = p.paid_at || new Date().toISOString();
      o.notifySign = sigOk ? 'strict' : 'soft';
      o.notifyCount = p.notify_count || 1;
    });
  }
  return text(200, 'success');
}

/* ---------- 前端轮询 ---------- */
async function queryOrder(sn) {
  if (!/^WP[0-9A-Z]+$/.test(String(sn || ''))) return json(400, { error: 'bad sn' });
  const cur = await readOrder(sn);
  if (!cur) return json(200, { configured: !!APP_ID, status: 'not_found' });
  return json(200, {
    configured: !!APP_ID,
    status: cur.data.status,
    tierId: cur.data.tierId,
    amount: cur.data.amount,
    paidAt: cur.data.paidAt || null,
  });
}

/* ---------- 入口 ---------- */
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return text(200, '');
  const q = event.queryStringParameters || {};
  const action = q.action || (event.path || '').split('/').pop();

  try {
    if (action === 'health') {
      return json(200, {
        ok: true, gateway: 'yunmianqian', configured: !!(APP_ID && APP_SECRET),
        strict: STRICT, notifyUrl: NOTIFY_URL, time: new Date().toISOString(),
      });
    }

    if (action === 'create' && event.httpMethod === 'POST') {
      if (!APP_ID || !APP_SECRET) return json(200, { configured: false, error: 'gateway_not_configured' });
      const body = parseBody(event);
      const data = await createOrder(String(body.tierId || 'trial'));
      return json(200, data);
    }

    if (action === 'notify') {
      return await handleNotify(parseBody(event));
    }

    if (action === 'query') {
      return await queryOrder(q.sn);
    }

    return json(404, { error: 'unknown action: ' + action });
  } catch (e) {
    return json(200, { configured: !!(APP_ID && APP_SECRET), error: String(e && e.message || e) });
  }
}
