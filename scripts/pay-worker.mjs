/* =====================================================================
 * scripts/pay-worker.mjs —— 支付订单自动到账 worker（GitHub Actions 专用）
 *
 * 架构：GitHub Pages 纯静态站收不到支付回调，用仓库自己当"服务端"：
 *   前端写订单文件(data/pay/orders/<sn>.json) → repository_dispatch 触发本 worker
 *   → worker 用仓库 Secrets 里的 XorPay 密钥下单 → 二维码写回订单文件
 *   → 低频查询订单状态 → 真支付后写 status=paid → 前端轮询读文件解锁额度
 *
 * 支付网关：XorPay（https://xorpay.com）——个人实名可开，无需营业执照。
 *   · 下单 POST https://xorpay.com/api/pay/{aid}
 *       签名 = md5(name+pay_type+price+order_id+notify_url+secret)
 *       返回 aoid（平台订单号）+ info.qr（weixin:// 二维码内容）
 *   · 查询 GET https://xorpay.com/api/query/{aoid}  —— 无需签名，低频调用
 *       status: new 未支付 / payed 已支付未回调 / success 已支付已回调 / expire 过期
 *
 * 低频保护：文件租约保证同一订单 60 秒内最多查 1 次；sha 冲突做原子认领；
 *          单订单最多 6 轮，覆盖二维码有效期后自动退出。
 *
 * 密钥绝不出现在前端：XORPAY_AID / XORPAY_SECRET 走 GitHub 仓库 Secrets。
 * 未配置密钥时订单标记 unconfigured，前端降级静态收款码，绝不假装到账。
 * ===================================================================== */
'use strict';

import crypto from 'node:crypto';

const OWNER = '1yk8u';
const REPO = 'wallpaper';
const BRANCH = 'main';
const DIR = 'data/pay/orders';
const API_BASE = 'https://api.github.com/repos/' + OWNER + '/' + REPO;

const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const AID = process.env.XORPAY_AID || '';
const SECRET = process.env.XORPAY_SECRET || '';
const NOTIFY_URL = process.env.XORPAY_NOTIFY_URL || 'https://1yk8u.github.io/wallpaper/';
const RUN_ID = process.env.GITHUB_RUN_ID || String(Date.now());

/* XorPay 价格单位是「元」，字符串两位小数 */
const TIERS = {
  trial: { price: '0.50',  label: '体验一天' },
  p5:    { price: '5.00',  label: '50张' },
  p10:   { price: '10.00', label: '1000张' },
  p20:   { price: '20.00', label: '2000张' },
  p50:   { price: '50.00', label: '5000张' },
};

const ROUNDS = Number(process.env.PAY_ROUNDS || 6);
const ROUND_MS = Number(process.env.PAY_ROUND_MS || 50000);
const LEASE_MS = 60000;
const MAX_AGE_MS = 24 * 3600 * 1000;

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
    if (keep === false) return null;
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

/* 状态探针：前端据此判断网关是否开通；只在变化时写，避免刷 commit */
async function writeStatusIfNeeded() {
  const configured = !!(AID && SECRET);
  let cur = null;
  try {
    const j = await gh('GET', '/contents/' + encodeURI('data/pay/status.json') + '?ref=' + BRANCH + '&t=' + Date.now());
    cur = { data: JSON.parse(unb64(j.content)), sha: j.sha };
  } catch (e) {}
  const GATEWAY = 'xorpay';
  /* 配置状态或网关类型变了就立即写；否则 6 小时内不重复提交 */
  if (cur && cur.data.configured === configured && cur.data.gateway === GATEWAY
      && Date.now() - Date.parse(cur.data.updatedAt || '') < 6 * 3600 * 1000) return;
  const body = {
    message: 'pay: gateway status',
    content: b64(JSON.stringify({ configured, gateway: GATEWAY, updatedAt: new Date().toISOString() })),
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
  } catch (e) {}
}

/* ---------- XorPay：下单（NATIVE 扫码） ---------- */
async function createXorpayOrder(sn, tierId) {
  const tier = TIERS[tierId];
  if (!tier) throw new Error('invalid tier ' + tierId);
  const name = 'Wallpaper-' + tier.label;
  const payType = 'native';
  const price = tier.price;
  const p = {
    name,
    pay_type: payType,
    price,
    order_id: sn,
    notify_url: NOTIFY_URL,
  };
  /* 签名顺序：name + pay_type + price + order_id + notify_url + secret */
  p.sign = md5(name + payType + price + sn + NOTIFY_URL + SECRET);

  const url = 'https://xorpay.com/api/pay/' + encodeURIComponent(AID);
  const r = await fetch(url, {
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
  if (j.status !== 'ok') throw new Error('gateway ' + (j.status || r.status) + ': ' + (j.info || 'unknown'));
  return { aoid: j.aoid || '', qr: (j.info && j.info.qr) || '', expireIn: Number(j.expire_in || j.expires_in || 7200) };
}

/* ---------- XorPay：查询（无需签名，用平台订单号 aoid） ---------- */
async function queryXorpay(aoid) {
  if (!aoid) return null;
  const r = await fetch('https://xorpay.com/api/query/' + encodeURIComponent(aoid), {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'User-Agent': 'wallpaper-pay-worker/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('query not json (' + r.status + ')'); }
  return j;   // { status: new|payed|success|expire|not_exist|fee_error }
}

/* ---------- 主流程 ---------- */
async function main() {
  if (!GH_TOKEN) { log('no GH_TOKEN, exit'); return; }
  await writeStatusIfNeeded();

  const now = Date.now();
  const files = await listOrderFiles();
  log('order files:', files.length, '| gateway configured:', !!(AID && SECRET));

  /* 清理 24 小时前的订单 */
  for (const f of files) {
    const sn = String(f.name || '').replace(/\.json$/, '');
    if (!/^WP[0-9A-Z]+$/.test(sn)) continue;
    const ts = parseInt(sn.slice(2, -4), 36);
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

    if (!AID || !SECRET) {
      await mutateOrder(sn, o => {
        if (o.status !== 'processing') return false;
        o.status = 'unconfigured';
        o.reason = '站点尚未在仓库 Secrets 中配置 XORPAY_AID / XORPAY_SECRET';
        return true;
      });
      log(sn, '-> unconfigured');
      continue;
    }

    try {
      const d = await createXorpayOrder(sn, claimed.tierId);
      await mutateOrder(sn, o => {
        o.status = 'waiting';
        o.aoid = d.aoid;
        o.qr = d.qr;                                   // weixin:// 链接 → 前端生成二维码
        o.payPrice = Number(TIERS[claimed.tierId].price);  // 单位元
        o.expireIn = d.expireIn;
        o.leaseUntil = 0;
        return true;
      });
      log(sn, '-> waiting (qr ready, aoid=' + d.aoid + ')');
    } catch (e) {
      await mutateOrder(sn, o => { o.status = 'error'; o.reason = String(e.message || e).slice(0, 180); return true; });
      log(sn, '-> error', e.message);
    }
  }

  if (!AID || !SECRET) { log('gateway not configured, exit'); return; }

  /* 2) 低频查询：文件租约保证每单 ≥60 秒只查一次 */
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
        const j = await queryXorpay(cur.data.aoid);
        const st = String((j && j.status) || '');
        if (st === 'payed' || st === 'success') {
          await mutateOrder(sn, o => {
            if (o.status === 'paid') return false;
            o.status = 'paid';
            o.paidAt = new Date().toISOString();
            o.cloudStatus = st;
            return true;
          });
          log(sn, '-> PAID (' + st + ')');
        } else if (st === 'expire' || st === 'not_exist') {
          await mutateOrder(sn, o => { o.status = 'expired'; return true; });
        }
      } catch (e) { log('query err', sn, e.message); }
    }
    log('round', round, '| waiting:', live, '| queried:', didQuery);
    if (!live) break;
    if (round < ROUNDS) await sleep(ROUND_MS);
  }
}

main().catch(e => { console.error('[pay] fatal', e); process.exitCode = 1; });
