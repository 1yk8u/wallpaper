/* =====================================================================
 * payment.js —— 壁纸库付费下载系统  v2
 *
 * 档位（按用户最新要求）：
 *   免费      每天 100 张
 *   ¥0.5      体验一天（24h 内每天 200 张）
 *   ¥5        50 张（一次性额度包，永久有效）
 *   ¥10       1000 张
 *   ¥20       2000 张
 *   ¥50       5000 张
 *   自定义     ≥0.5 元，按向下匹配档位生效
 *   邀请码    zub571795 → 无限（加好友后发放）
 *
 * 到账检测：真实链路
 *   下单 → 云免签返回付款二维码 → 前端每 3s 轮询订单状态
 *   → 云端回调 notify 验签写状态 → 轮询查到 paid 才解锁额度
 *   未开通网关时降级为「静态收款码 + 人工核对」，绝不再假装到账
 *
 * 速度：二维码用本地 assets/（Netlify CDN），QR 生成库按需加载，首屏零负担
 * ===================================================================== */
'use strict';

const Payment = (() => {
  /* ===== 配置 ===== */
  const FREE_DAILY_LIMIT = 100;
  const MIN_CUSTOM_AMOUNT = 0.5;
  const INVITE_CODES = { 'zub571795': 'unlimited' };
  const API = '/.netlify/functions/pay';
  const QR_LIB = 'assets/qrcode.js';
  const QR_PAY = 'assets/pay-qr.png';
  const QR_CONTACT = 'assets/contact-qr.png';
  const POLL_MS = 3000;
  const MAX_POLL = 110;              // 约 5.5 分钟（二维码 5 分钟过期）

  const TIERS = [
    { id: 'trial', price: 0.5, kind: 'trial', daily: 200, hours: 24, title: '体验一天', desc: '24h 内每天 200 张' },
    { id: 'p5',    price: 5,   kind: 'credits', credits: 50,   title: '50 张',   desc: '永久有效 · 用完为止' },
    { id: 'p10',   price: 10,  kind: 'credits', credits: 1000, title: '1000 张', desc: '永久有效 · 用完为止' },
    { id: 'p20',   price: 20,  kind: 'credits', credits: 2000, title: '2000 张', desc: '永久有效 · 用完为止' },
    { id: 'p50',   price: 50,  kind: 'credits', credits: 5000, title: '5000 张', desc: '永久有效 · 用完为止' },
  ];

  /* ===== 存储 Key ===== */
  const K_QUOTA = 'wallpaper_quota_v2';
  const K_PACK = 'wallpaper_pack_v2';       // 一次性张数包
  const K_TRIAL = 'wallpaper_trial_v2';     // 体验有效期
  const K_INVITE = 'wallpaper_invite_v1';   // 兼容旧数据
  const K_PAYMENT = 'wallpaper_payment_v2'; // 付款记录 / 防重复领取
  const K_PENDING = 'wallpaper_pending_v2'; // 未完成订单（刷新后可继续轮询）

  /* ===== 工具 ===== */
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function loadJSON(key, fallback) {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function fmt(n) { return Number(n).toFixed(2).replace(/\.00$/, ''); }

  /* ===== 状态 ===== */
  function getQuotaState() {
    const q = loadJSON(K_QUOTA, { date: today(), used: 0 });
    if (q.date !== today()) { q.date = today(); q.used = 0; saveJSON(K_QUOTA, q); }
    return q;
  }
  function getPackState() {
    return loadJSON(K_PACK, { credits: 0, total: 0 });
  }
  function getTrialState() {
    return loadJSON(K_TRIAL, { expireAt: 0 });
  }
  function getInviteState() {
    return loadJSON(K_INVITE, { code: null, unlimited: false });
  }
  function getPaymentState() {
    return loadJSON(K_PAYMENT, { level: 'free', amount: 0, orders: [] });
  }
  function isTrialActive() {
    return getTrialState().expireAt > Date.now();
  }
  function isUnlimited() {
    return !!getInviteState().unlimited;
  }

  /* ===== 额度 ===== */
  function getDailyLimit() {
    if (isUnlimited()) return Infinity;
    if (isTrialActive()) return TIERS[0].daily;
    return FREE_DAILY_LIMIT;
  }
  function getDailyRemaining() {
    const limit = getDailyLimit();
    if (limit === Infinity) return Infinity;
    return Math.max(0, limit - getQuotaState().used);
  }
  function getRemaining() {
    if (isUnlimited()) return Infinity;
    return getDailyRemaining() + Math.max(0, getPackState().credits);
  }
  function canDownload() { return getRemaining() > 0; }

  function consumeDownload() {
    if (!canDownload()) return false;
    if (getDailyRemaining() > 0) {
      const q = getQuotaState();
      q.used++;
      saveJSON(K_QUOTA, q);
    } else {
      const p = getPackState();
      p.credits = Math.max(0, p.credits - 1);
      saveJSON(K_PACK, p);
    }
    return true;
  }

  /* ===== 邀请码 ===== */
  function redeemInviteCode(code) {
    const c = String(code || '').trim();
    if (INVITE_CODES[c]) {
      saveJSON(K_INVITE, { code: c, unlimited: true });
      return { ok: true, message: '邀请码激活成功！已解锁无限下载' };
    }
    return { ok: false, message: '邀请码无效，需加好友获取' };
  }

  /* ===== 档位匹配 ===== */
  function tierById(id) { return TIERS.find(t => t.id === id) || null; }
  function tierByAmount(amount) {
    const a = parseFloat(amount);
    if (isNaN(a) || a < MIN_CUSTOM_AMOUNT) return null;
    let best = TIERS[0];
    for (const t of TIERS) if (a >= t.price && t.price >= best.price) best = t;
    return best;
  }

  /* ===== 到账后解锁（服务端校验过状态才调用） ===== */
  function activatePayment(amount, orderSn, tierId) {
    const tier = tierById(tierId) || tierByAmount(amount);
    if (!tier) return { ok: false, message: '金额不能低于 ' + MIN_CUSTOM_AMOUNT + ' 元' };

    const pay = getPaymentState();
    pay.orders = pay.orders || [];
    if (orderSn && pay.orders.indexOf(orderSn) !== -1) {
      return { ok: false, message: '该订单已领取过额度' };
    }

    const now = new Date().toISOString();
    let message;

    if (tier.kind === 'trial') {
      const until = Date.now() + tier.hours * 3600 * 1000;
      saveJSON(K_TRIAL, { expireAt: Math.max(getTrialState().expireAt, until) });
      message = '支付成功！已解锁「体验一天」：24 小时内每天可下载 ' + tier.daily + ' 张';
    } else {
      const p = getPackState();
      p.credits = (p.credits || 0) + tier.credits;
      p.total = (p.total || 0) + tier.credits;
      saveJSON(K_PACK, p);
      message = '支付成功！已到账 ' + tier.credits + ' 张下载额度（永久有效）';
    }

    if (orderSn) pay.orders.push(orderSn);
    pay.level = tier.id;
    pay.amount = (pay.amount || 0) + tier.price;
    pay.paidAt = now;
    pay.expireDate = tier.kind === 'trial' ? new Date(getTrialState().expireAt).toISOString().slice(0, 10) : null;
    saveJSON(K_PAYMENT, pay);
    return { ok: true, message };
  }

  /* ===== 样式（只注入一次） ===== */
  function injectPaymentStyles() {
    if (document.getElementById('payment-styles')) return;
    const s = document.createElement('style');
    s.id = 'payment-styles';
    s.textContent = `
.pay-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);padding:16px}
.pay-card{background:#fff;border-radius:20px;max-width:460px;width:100%;max-height:92vh;overflow-y:auto;padding:26px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3);color:#1f2937}
.pay-close{position:absolute;top:10px;right:14px;background:none;border:none;font-size:26px;cursor:pointer;color:#9ca3af;line-height:1;padding:4px 8px;border-radius:8px}
.pay-close:hover{background:#f3f4f6;color:#111}
.pay-title{text-align:center;margin:0 0 14px;font-size:21px}
.pay-status{text-align:center;padding:10px 14px;border-radius:12px;margin-bottom:18px;font-size:13px;background:#f0f7ff;color:#1d4ed8}
.pay-status.unlimited{background:#f0fdf4;color:#15803d}
.pay-tiers{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-bottom:16px}
.pay-tier{border:2px solid #e5e7eb;border-radius:12px;padding:10px 4px;text-align:center;cursor:pointer;transition:.16s}
.pay-tier:hover{border-color:#93c5fd;transform:translateY(-2px)}
.pay-tier.active{border-color:#2563eb;background:#eff6ff}
.pay-tier-amount{font-size:17px;font-weight:800;color:#2563eb}
.pay-tier-title{font-size:11px;font-weight:700;margin:3px 0 2px}
.pay-tier-desc{font-size:10px;color:#6b7280;line-height:1.35}
.pay-custom{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px;color:#4b5563}
.pay-custom input{width:90px;padding:8px 10px;border:2px solid #e5e7eb;border-radius:10px;font-size:15px;outline:none}
.pay-custom input:focus{border-color:#2563eb}
.pay-custom small{color:#9ca3af}
.pay-go{width:100%;padding:13px;font-size:16px;font-weight:700;border:none;border-radius:12px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;cursor:pointer;margin-bottom:14px}
.pay-go:disabled{opacity:.55;cursor:not-allowed}
.pay-stage{text-align:center;padding:16px;background:#f9fafb;border-radius:14px;margin-bottom:14px;min-height:60px}
.pay-stage-title{font-size:14px;font-weight:700;margin-bottom:8px}
.pay-stage-hint{font-size:12px;color:#6b7280;line-height:1.6}
.pay-price{font-size:28px;font-weight:800;color:#dc2626;letter-spacing:-.5px}
.pay-qr-box{display:flex;justify-content:center;margin:12px 0 8px}
.pay-qr-box svg{width:210px;height:210px;background:#fff;border:8px solid #fff;border-radius:10px}
.pay-qr-static{width:200px;height:200px;object-fit:contain;border:2px solid #e5e7eb;border-radius:12px}
.pay-count{font-size:12px;color:#dc2626;font-weight:700}
.pay-warn{background:#fef2f2;color:#b91c1c;padding:9px 12px;border-radius:10px;font-size:12px;line-height:1.6;margin-bottom:10px;text-align:left}
.pay-ok{background:#f0fdf4;color:#15803d;padding:12px;border-radius:10px;font-size:14px;font-weight:700}
.pay-detect{display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:#6b7280;margin-top:8px}
.pay-spin{width:15px;height:15px;border:2px solid #d1d5db;border-top-color:#2563eb;border-radius:50%;animation:paySpin .7s linear infinite}
@keyframes paySpin{to{transform:rotate(360deg)}}
.pay-divider{border-top:1px solid #eee;margin:18px 0 14px}
.pay-invite-row{display:flex;gap:8px}
.pay-invite-row input{flex:1;padding:9px 11px;border:2px solid #e5e7eb;border-radius:10px;font-size:14px;outline:none}
.pay-invite-row input:focus{border-color:#2563eb}
.pay-invite-row button{padding:9px 16px;border-radius:10px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:13px}
.pay-invite-hint{font-size:11px;color:#9ca3af;margin-top:6px}
.pay-contact{text-align:center;margin-top:14px}
.pay-contact p{font-size:12px;color:#6b7280;margin:0 0 8px}
.pay-contact-qr{width:130px;height:130px;object-fit:contain;border-radius:10px;border:1px solid #eee}
.hidden{display:none!important}
@media(max-width:480px){.pay-tiers{grid-template-columns:repeat(3,1fr)}.pay-card{padding:20px}}
`;
    document.head.appendChild(s);
  }

  /* ===== 弹窗 ===== */
  let pollTimer = null;
  let countTimer = null;

  function showPaymentModal() {
    const old = document.getElementById('modal-payment');
    if (old) old.remove();
    stopPolling();

    const rem = getRemaining();
    const lim = getDailyLimit();
    const pack = getPackState();
    let statusHtml;
    if (isUnlimited()) {
      statusHtml = '<div class="pay-status unlimited">无限下载（邀请码 / 已解锁）</div>';
    } else {
      statusHtml = '<div class="pay-status">今日剩余 <strong>' + (lim === Infinity ? '∞' : Math.max(0, lim - getQuotaState().used)) + '</strong> / ' + lim + ' 张'
        + (pack.credits > 0 ? ' ｜ 套餐余量 <strong>' + pack.credits + '</strong> 张' : '')
        + '</div>';
    }

    const tierHtml = TIERS.map((t, i) => `
      <div class="pay-tier ${i === 0 ? 'active' : ''}" data-tier="${t.id}">
        <div class="pay-tier-amount">¥${fmt(t.price)}</div>
        <div class="pay-tier-title">${t.title}</div>
        <div class="pay-tier-desc">${t.desc}</div>
      </div>`).join('');

    const html = `
<div class="pay-overlay" id="modal-payment">
  <div class="pay-card">
    <button class="pay-close" id="pay-close">&times;</button>
    <h2 class="pay-title">解锁更多下载</h2>
    ${statusHtml}
    <div class="pay-tiers" id="pay-tiers">${tierHtml}</div>
    <div class="pay-custom">
      <span>自定义 ¥</span>
      <input type="number" id="pay-custom-amount" min="0.5" step="0.1" value="0.5">
      <small>（最低 0.5，按对应档位生效）</small>
    </div>
    <button class="pay-go" id="pay-go">立即支付</button>
    <div class="pay-stage hidden" id="pay-stage"></div>
    <div class="pay-divider"></div>
    <div class="pay-invite-row">
      <input type="text" id="pay-invite-code" placeholder="输入邀请码" maxlength="20">
      <button id="pay-invite-btn">兑换</button>
    </div>
    <div class="pay-invite-hint">免费邀请码需添加下方微信好友，同意后才会发放</div>
    <div class="pay-contact">
      <p>获取邀请码 / 付款问题，扫码加好友</p>
      <img src="${QR_CONTACT}" alt="微信联系码" class="pay-contact-qr" loading="lazy">
    </div>
  </div>
</div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    injectPaymentStyles();
    const $ = id => document.getElementById(id);

    $('pay-close').addEventListener('click', () => { stopPolling(); $('modal-payment').remove(); });
    $('modal-payment').addEventListener('click', e => {
      if (e.target.id === 'modal-payment') { stopPolling(); $('modal-payment').remove(); }
    });

    let selected = TIERS[0].id;
    document.querySelectorAll('.pay-tier').forEach(el => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.pay-tier').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        selected = el.dataset.tier;
        $('pay-custom-amount').value = tierById(selected).price;
        $('pay-stage').classList.add('hidden');
      });
    });

    $('pay-go').addEventListener('click', () => {
      const a = parseFloat($('pay-custom-amount').value);
      const t = tierByAmount(a);
      if (!t) { alert('金额不能低于 0.5 元'); return; }
      selected = t.id;
      startPaymentFlow(t);
    });

    $('pay-invite-btn').addEventListener('click', () => {
      const r = redeemInviteCode($('pay-invite-code').value);
      alert(r.message);
      if (r.ok) { $('modal-payment').remove(); updateQuotaDisplay(); }
    });
    $('pay-invite-code').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('pay-invite-btn').click();
    });

    /* 有未完成订单 → 自动恢复轮询（刷新页面也不丢单） */
    const pending = loadJSON(K_PENDING, null);
    if (pending && pending.sn && Date.now() - pending.at < 6 * 60 * 1000) {
      resumePolling(pending);
    }
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (countTimer) { clearInterval(countTimer); countTimer = null; }
  }

  function stage(html) {
    const el = document.getElementById('pay-stage');
    if (el) { el.innerHTML = html; el.classList.remove('hidden'); }
  }

  /* ===== 真实下单 + 轮询到账 ===== */
  async function startPaymentFlow(tier) {
    const go = document.getElementById('pay-go');
    /* 非 Netlify 域名（如 GitHub Pages）没有后端函数，直接进静态收款码模式，不空等 404 */
    if (!/netlify\.app$/i.test(location.hostname)) {
      gatewayUnavailable(tier, '当前站点未挂载支付后端函数');
      return;
    }
    if (go) { go.disabled = true; go.textContent = '正在创建订单…'; }
    stage('<div class="pay-stage-hint">正在创建支付订单…</div><div class="pay-detect"><span class="pay-spin"></span>连接支付网关</div>');

    let res, data;
    try {
      res = await fetch(API + '?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierId: tier.id, amount: tier.price }),
        signal: AbortSignal.timeout(12000),
      });
      data = await res.json();
    } catch (e) {
      gatewayUnavailable(tier, '无法连接支付服务（' + (e.message || 'network') + '）');
      return;
    } finally {
      if (go) { go.disabled = false; go.textContent = '重新下单 / 立即支付'; }
    }

    if (!res.ok || data.error) {
      gatewayUnavailable(tier, data.error || ('支付服务返回 ' + res.status));
      return;
    }
    if (!data.configured) {
      gatewayUnavailable(tier, '站点尚未开通支付网关');
      return;
    }

    saveJSON(K_PENDING, { sn: data.sn, tierId: tier.id, at: Date.now() });
    renderLiveOrder(data, tier);
  }

  /* ===== 网关返回的动态付款码 ===== */
  function renderLiveOrder(d, tier) {
    const qr = String(d.qr || '');
    const price = d.payPrice || tier.price;
    const secs = Math.max(0, parseInt(d.expireIn, 10) || 300);
    const deadline = Date.now() + secs * 1000;

    stage(`
      <div class="pay-stage-title">微信扫码支付</div>
      <div>应付金额 <span class="pay-price">¥${fmt(price)}</span></div>
      <div class="pay-stage-hint">请用微信扫下方二维码，务必支付 <b>这个金额</b>（用于自动识别订单）</div>
      <div class="pay-qr-box" id="pay-qr-box"><div class="pay-stage-hint">二维码生成中…</div></div>
      <div class="pay-count" id="pay-count">二维码剩余 ${secs} 秒</div>
      <div class="pay-detect" id="pay-detect"><span class="pay-spin"></span>等待扫码支付，到账后自动解锁</div>
    `);

    ensureQrLib(ok => {
      const box = document.getElementById('pay-qr-box');
      if (!box) return;
      if (ok && qr) {
        try {
          const q = window.qrcode(0, 'L');
          q.addData(qr);
          q.make();
          box.innerHTML = q.createSvgTag({ cellSize: 5, margin: 1, scalable: true });
          return;
        } catch (e) { /* 落到静态码 */ }
      }
      box.innerHTML = '<img class="pay-qr-static" src="' + QR_PAY + '" alt="收款码">';
    });

    if (countTimer) clearInterval(countTimer);
    countTimer = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const el = document.getElementById('pay-count');
      if (el) el.textContent = left > 0 ? '二维码剩余 ' + left + ' 秒' : '二维码已过期，请重新下单';
      if (left <= 0) { clearInterval(countTimer); countTimer = null; }
    }, 1000);

    startPolling(d.sn, tier, deadline);
  }

  /* ===== 按需加载 QR 生成库（首屏不加载，速度优先） ===== */
  function ensureQrLib(cb) {
    if (window.qrcode) { cb(true); return; }
    const s = document.createElement('script');
    s.src = QR_LIB;
    s.async = true;
    s.onload = () => cb(!!window.qrcode);
    s.onerror = () => cb(false);
    document.head.appendChild(s);
  }

  /* ===== 轮询订单状态（真·检测，绝不假装） ===== */
  function startPolling(sn, tier, deadline) {
    stopPolling();
    let n = 0;
    pollTimer = setInterval(async () => {
      n++;
      if (!document.getElementById('modal-payment')) { stopPolling(); return; }
      if (n > MAX_POLL || (deadline && Date.now() > deadline + 30000)) {
        stopPolling();
        const el = document.getElementById('pay-detect');
        if (el) el.innerHTML = '未检测到到账。若已付款，请扫码加好友凭订单号 <b>' + sn + '</b> 核对';
        return;
      }
      try {
        const r = await fetch(API + '?action=query&sn=' + encodeURIComponent(sn), { signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (j.status === 'paid') {
          stopPolling();
          localStorage.removeItem(K_PENDING);
          const rst = activatePayment(tier.price, sn, j.tierId || tier.id);
          stage('<div class="pay-ok">支付成功，额度已到账<br><span style="font-size:12px;font-weight:400">' + (rst.message || '') + '</span></div>');
          updateQuotaDisplay();
          setTimeout(() => { const m = document.getElementById('modal-payment'); if (m) m.remove(); }, 3200);
        }
      } catch (e) { /* 单次失败继续轮询 */ }
    }, POLL_MS);
  }

  function resumePolling(p) {
    const tier = tierById(p.tierId) || TIERS[0];
    stage('<div class="pay-stage-title">检测到未完成订单</div><div class="pay-stage-hint">订单号 ' + p.sn + '</div><div class="pay-detect"><span class="pay-spin"></span>正在继续检测到账状态</div>');
    startPolling(p.sn, tier, 0);
  }

  /* ===== 网关未开通 / 不可用：静态收款码 + 人工核对（不假装到账） ===== */
  function gatewayUnavailable(tier, reason) {
    stopPolling();
    const sn = 'M' + Date.now().toString(36).toUpperCase();
    stage(`
      <div class="pay-warn"><b>自动到账检测暂未开启</b><br>${reason}<br>可先扫码付款，保存订单号后加下方微信好友核对领取。</div>
      <div class="pay-stage-title">微信扫码支付 ¥${fmt(tier.price)}</div>
      <div class="pay-qr-box"><img class="pay-qr-static" src="${QR_PAY}" alt="微信收款码"></div>
      <div class="pay-stage-hint">档位：${tier.title}（${tier.desc}）<br>订单号 <b>${sn}</b>　付款后请截图保存</div>
    `);
  }

  /* ===== 顶栏额度徽章 ===== */
  function updateQuotaDisplay() {
    const rem = getRemaining();
    const lim = getDailyLimit();
    document.querySelectorAll('[data-quota-display]').forEach(el => {
      if (rem === Infinity) el.textContent = '♾️ 无限';
      else el.textContent = '今日 ' + Math.max(0, lim - getQuotaState().used) + '/' + lim
        + (getPackState().credits > 0 ? ' +' + getPackState().credits : '');
    });
  }

  /* ===== 公开 API（保持 core.js 兼容） ===== */
  return {
    canDownload, consumeDownload, getRemaining, getDailyLimit, getQuotaState,
    showPaymentModal, activatePayment, getPaymentState,
    redeemInviteCode, getInviteState,
    updateQuotaDisplay, injectPaymentStyles,
    TIERS, FREE_DAILY_LIMIT, MIN_CUSTOM_AMOUNT,
  };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { Payment.injectPaymentStyles(); Payment.updateQuotaDisplay(); });
} else {
  Payment.injectPaymentStyles();
  Payment.updateQuotaDisplay();
}
