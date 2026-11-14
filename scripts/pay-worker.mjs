/* =====================================================================
 * scripts/pay-worker.mjs —— 支付订单自动到账 worker（GitHub Actions 专用）
 *
 * 为什么需要它：GitHub Pages 是纯静态站，收不到云免签的 POST 回调；
 * Netlify 免费额度冻结期间也挂不了函数。于是用仓库自己当"服务端"：
 *
 *   前端写订单文件(data/pay/orders/<sn>.json) → repository_dispatch 触发本 worker
 *   → worker 用仓库 Secrets 里的 app_secret 调云免签下单 → 二维码写回订单文件
 *   → 低频辅助查询订单状态 → 真支付后写 status=paid → 前端轮询读文件解锁额度
 *
 * 云免签官方明确禁止"高频轮询"查询接口（会封 IP），所以这里用：
 *   · 文件租约（lease）保证同一订单 60 秒内最多被查 1 次
 *   · 多 worker 并发时靠 GitHub Contents API 的 sha 冲突做原子认领
 *   · 单订单最多 6 轮，覆盖二维码 5 分钟有效期后自动退出
 *   · 同时接受 paid(已支付未回调) 与 success(已回调) 两种状态
 *
 * 密钥绝不出现在前端：YMQ_APP_ID / YMQ_APP_SECRET 走 GitHub 仓库 Secrets。
 * 未配置密钥时，订单被标记 unconfigured，前端降级为静态收款码，绝不假装到账。
 * ===================================================================== */
'use strict';

import crypto from 'node:crypto';

const OWNER = '1yk8u';
const REPO = 'wallpaper';
const BRANCH = 'main';
const DIR = 'data/pay/orders';
const API_BASE = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const APP_ID = process.env.YMQ_APP_ID || '';
const APP_SECRET = process.env.YMQ_APP_SECRET || '';
const NOTIFY_URL = process.env.YMQ_NOTIFY_URL || 'https://1yk8u.github.io/wallpaper/';
const RUN_ID = process.env.GITHUB_RUN_ID || String(Date.now());

const YMQ_PAY = 'https://open.yunmianqian.com/api/pay?order_cache=true';
const YMQ_QUERY = 'https://open.yunmianqian.com/api/query';

const ROUNDS = Number(process.env.PAY_ROUNDS || 6);
const ROUND_MS = Number(process.env.PAY_ROUND_MS || 50000);
const LEASE_MS = 60000;
const MAX_AGE_MS = 24 * 3600 * 1000;

/* 档位锁定：金额不允许前端篡改，与 payment.js 的 TIERS 一一对应 */
const TIERS = {
  trial: { price: 50,   label: '体验一天' },
  p5:    { price: 500,  label: '50张' },
  p10:   { price: 1000, label: '1000张' },
  p20:   { price: 2000, label: '2000张' },
  p50:   { price: 5000, label: '5000张' },
};

const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = s => Buffer.from(String(s), 'base64').toString('utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[pay]', ...a);

function ghHeaders(extra) {
  return {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wallpaper-pay-worker',
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}
async function gh(method, path, body) {
  const r = await fetch(API_BASE + path, {
    method,
    headers: ghHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 200);
    throw new Error('GitHub ' + r.status + ' ' + t);
  }
  return r.status === 204 ? null : r.json();
}

const orderPath = sn => DIR + '/' + sn + '.json';

async function readOrder(sn) {
  try {
    const j = await gh('GET', '/contents/' + encodeURI(orderPath(sn)) + '?ref=' + BRANCH + '&t=' + Date.now());
    return { data: JSON.parse(unb64(j.content)), sha: j.sha };
  } catch (e) { return null; }
}

/* 读后写 + sha 冲突重试：并发 worker 靠这个做原子认领 */
async function mutateOrder(sn, mutate) {
  for (let i = 0; i < 4; i++) {
    const cur = await readOrder(sn);
    if (!cur) return null;
    const next = { ...cur.data };
    const keep = mutate(next);
    if (keep === false) return null;          // 认领失败 / 无需改动
    next.updatedAt = new Date().toISOString();
    try {
      await gh('PUT', '/contents/' + encodeURI(orderPath(sn)), {
        message: 'pay: ' + sn + ' ' + (next.status || 'update'),
        content: b64(JSON.stringify(next)),
        branch: BRANCH,
        sha: cur.sha,
      });
      return next;
    } catch (e) {
      if (i === 3) { log('write failed', sn, e.message); return null; }
      await sleep(400 + i * 300);
    }
  }
  return null;
}

/* 状态探针：前端据此判断网关是否已开通，未开通立即降级静态码，不空等冷启动。
 * 只在状态变化或超过 6 小时才写一次，避免每 10 分钟刷一条 commit。 */
async function writeStatusIfNeeded() {
  const configured = !!(APP_ID && APP_SECRET);
  let cur = null;
  try {
    const j = await gh('GET', '/contents/' + encodeURI('data/pay/status.json') + '?ref=' + BRANCH + '&t=' + Date.now());
    cur = { data: JSON.parse(unb64(j.content)), sha: j.sha };
  } catch (e) { /* 文件还不存在 */ }
  if (cur && cur.data.configured === configured && Date.now() - Date.parse(cur.data.updatedAt || '') < 6 * 3600 * 1000) return;
  const body = {
    message: 'pay: gateway status',
    content: b64(JSON.stringify({ configured, gateway: 'yunmianqian', updatedAt: new Date().toISOString() })),
    branch: BRANCH,
  };
  if (cur) body.sha = cur.sha;
  try { await gh('PUT', '/contents/' + encodeURI('data/pay/status.json'), body); }
  catch (e) { log('status write skipped', e.message); }
}

async function listOrderFiles() {
  try {
    const arr = await gh('GET', '/contents/' + DIR + '?ref=' + BRANCH + '&t=' + Date.now());
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

async function deleteOrder(sn, sha) {
  try {
    await gh('DELETE', '/contents/' + encodeURI(orderPath(sn)), {
      message: 'pay: cleanup ' + sn, branch: BRANCH, sha,
    });
  } catch (e) { /* 清理失败不影响主流程 */ }
}

/* ---------- 云免签：下单 ---------- */
async function createYmqOrder(sn, tierId) {
  const tier = TIERS[tierId];
  if (!tier) throw new Error('invalid tier ' + tierId);
  const name = '壁纸额度-' + tier.label;
  const p = {
    app_id: APP_ID,
    out_order_sn: sn,
    name,
    pay_way: 'wechat',
    price: String(tier.price),
    attach: tierId,
    notify_url: NOTIFY_URL,
  };
  p.sign = md5(p.app_id + p.out_order_sn + p.name + p.pay_way + p.price + p.attach + p.notify_url + APP_SECRET);

  const r = await fetch(YMQ_PAY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
    body: new URLSearchParams(p).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('gateway not json (' + r.status + ')'); }
  if (j.code !== 200 || !j.data) throw new Error('gateway ' + j.code + ': ' + (j.msg || 'unknown'));
  return j.data;
}

/* ---------- 云免签：低频辅助查询（每订单 ≥60 秒一次） ---------- */
async function queryYmq(sn) {
  const orderSn = '';
  const p = { app_id: APP_ID, order_sn: orderSn, out_order_sn: sn };
  p.sign = md5(p.app_id + p.order_sn + p.out_order_sn + APP_SECRET);
  const r = await fetch(YMQ_QUERY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json',
      'User-Agent': 'wallpaper-pay-worker/1.0',
    },
    body: new URLSearchParams(p).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('query not json (' + r.status + ')'); }
  if (j.code !== 200) throw new Error('query ' + j.code + ': ' + (j.msg || 'unknown'));
  const list = (j.data && j.data.list) || [];
  return list[0] || null;
}

/* ---------- 主流程 ---------- */
async function main() {
  if (!GH_TOKEN) { log('no GH_TOKEN, exit'); return; }
  await writeStatusIfNeeded();

  const now = Date.now();
  const files = await listOrderFiles();
  log('order files:', files.length, '| gateway configured:', !!(APP_ID && APP_SECRET));

  /* 清理 24 小时前的订单，避免仓库文件无限增长 */
  for (const f of files) {
    const sn = String(f.name || '').replace(/\.json$/, '');
    if (!/^WP[0-9A-Z]+$/.test(sn)) continue;
    const tsPart = sn.slice(2, -4);
    const ts = parseInt(tsPart, 36);
    if (Number.isFinite(ts) && ts < now - MAX_AGE_MS) await deleteOrder(sn, f.sha);
  }

  /* 1) 认领 creating 订单 → 下单 → 写回二维码 */
  for (const f of files) {
    const sn = String(f.name || '').replace(/\.json$/, '');
    if (!/^WP[0-9A-Z]+$/.test(sn)) continue;
    const cur = await readOrder(sn);
    if (!cur || cur.data.status !== 'creating') continue;

    const claimed = await mutateOrder(sn, o => {
      if (o.status !== 'creating') return false;
      if (o.claimRun && o.claimRun !== RUN_ID) return false;
      o.status = 'processing';
      o.claimRun = RUN_ID;
      return true;
    });
    if (!claimed) continue;

    if (!APP_ID || !APP_SECRET) {
      await mutateOrder(sn, o => {
        if (o.status !== 'processing') return false;
        o.status = 'unconfigured';
        o.reason = '站点尚未在仓库 Secrets 中配置 YMQ_APP_ID / YMQ_APP_SECRET';
        return true;
      });
      log(sn, '-> unconfigured');
      continue;
    }

    try {
      const d = await createYmqOrder(sn, claimed.tierId);
      await mutateOrder(sn, o => {
        o.status = 'waiting';
        o.cloudSn = d.order_sn || '';
        o.qr = d.qr || '';
        o.payPrice = Number(d.pay_price || TIERS[claimed.tierId].price) / 100;
        o.expireAt = d.expire_at || '';
        o.createdAt = new Date().toISOString();
        o.leaseUntil = 0;
        return true;
      });
      log(sn, '-> waiting (qr ready)');
    } catch (e) {
      await mutateOrder(sn, o => { o.status = 'error'; o.reason = String(e.message || e).slice(0, 180); return true; });
      log(sn, '-> error', e.message);
    }
  }

  if (!APP_ID || !APP_SECRET) { log('gateway not configured, exit'); return; }

  /* 2) 低频辅助查询：文件租约保证每单 ≥60 秒只查一次 */
  for (let round = 1; round <= ROUNDS; round++) {
    const list = await listOrderFiles();
    let live = 0, didQuery = 0;
    for (const f of list) {
      const sn = String(f.name || '').replace(/\.json$/, '');
      if (!/^WP[0-9A-Z]+$/.test(sn)) continue;
      const cur = await readOrder(sn);
      if (!cur || cur.data.status !== 'waiting') continue;
      live++;

      const lease = Number(cur.data.leaseUntil || 0);
      if (lease > Date.now()) continue;

      const ok = await mutateOrder(sn, o => {
        if (o.status !== 'waiting') return false;
        if (Number(o.leaseUntil || 0) > Date.now()) return false;
        o.leaseUntil = Date.now() + LEASE_MS;
        o.leaseRun = RUN_ID;
        return true;
      });
      if (!ok) continue;
      didQuery++;

      try {
        const d = await queryYmq(sn);
        if (d) {
          const st = String(d.order_status || '').toLowerCase();
          const paid = st === 'paid' || st === 'success' || (!!d.paid_at && st !== 'closed');
          if (paid) {
            const priceOk = !d.pay_price || Number(d.pay_price) === Number(TIERS[cur.data.tierId]?.price || 0);
            if (priceOk) {
              await mutateOrder(sn, o => {
                if (o.status === 'paid') return false;
                o.status = 'paid';
                o.paidAt = d.paid_at || new Date().toISOString();
                o.cloudStatus = st;
                return true;
              });
              log(sn, '-> PAID (' + st + ')');
              continue;
            }
            log(sn, 'price mismatch, ignore', d.pay_price);
          } else if (st === 'closed') {
            await mutateOrder(sn, o => { o.status = 'expired'; return true; });
          }
        }
      } catch (e) { log('query err', sn, e.message); }
    }
    log('round', round, '| waiting:', live, '| queried:', didQuery);
    if (!live) break;
    if (round < ROUNDS) await sleep(ROUND_MS);
  }
}

main().catch(e => { console.error('[pay] fatal', e); process.exitCode = 1; });
