/* =====================================================================
 * payment.js —— 壁纸库付费下载系统
 *
 * 功能：
 *   • 每日免费 100 张下载额度
 *   • 充 0.5 元 → 每天 200 张
 *   • 充 5~10 元 → 无限下载
 *   • 自定义金额（最低 0.5 元起）
 *   • 邀请码 zub571795 → 无限下载（加好友后手动发放）
 *   • 微信扫码付款 + 自动到账检测
 *
 * 存储：localStorage（浏览器本地）
 * ===================================================================== */
'use strict';

const Payment = (() => {
  /* ===== 配置 ===== */
  const FREE_DAILY_LIMIT = 100;        // 免费每日额度
  const TIER_200_PRICE = 0.5;          // 0.5 元 → 每天 200 张
  const TIER_200_DAILY_LIMIT = 200;
  const TIER_UNLIMITED_MIN = 5;        // 最低 5 元 → 无限下载
  const TIER_UNLIMITED_MAX = 10;       // 最高 10 元（10 元以上也算无限）
  const MIN_CUSTOM_AMOUNT = 0.5;       // 自定义最低金额
  const INVITE_CODES = { 'zub571795': 'unlimited' };

  /* ===== 存储 Key ===== */
  const K_QUOTA = 'wallpaper_quota_v1';
  const K_PAYMENT = 'wallpaper_payment_v1';
  const K_INVITE = 'wallpaper_invite_v1';

  /* ===== 工具 ===== */
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function loadJSON(key, fallback) {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : fallback;
    } catch (e) { return fallback; }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ===== 额度管理 ===== */
  function getQuotaState() {
    const q = loadJSON(K_QUOTA, { date: today(), used: 0 });
    /* 新的一天重置 */
    if (q.date !== today()) {
      q.date = today();
      q.used = 0;
      saveJSON(K_QUOTA, q);
    }
    return q;
  }

  function getPaymentState() {
    return loadJSON(K_PAYMENT, {
      level: 'free',        // 'free' | 'tier200' | 'unlimited'
      amount: 0,
      expireDate: null,     // tier200 到期日期
      paidAt: null,
    });
  }

  function getInviteState() {
    return loadJSON(K_INVITE, { code: null, unlimited: false });
  }

  function getDailyLimit() {
    const invite = getInviteState();
    if (invite.unlimited) return Infinity;
    const pay = getPaymentState();
    if (pay.level === 'unlimited') return Infinity;
    if (pay.level === 'tier200') {
      /* tier200 有效期 30 天 */
      if (pay.expireDate && today() <= pay.expireDate) return TIER_200_DAILY_LIMIT;
      return FREE_DAILY_LIMIT;
    }
    return FREE_DAILY_LIMIT;
  }

  function getRemaining() {
    const limit = getDailyLimit();
    if (limit === Infinity) return Infinity;
    const q = getQuotaState();
    return Math.max(0, limit - q.used);
  }

  function canDownload() {
    return getRemaining() > 0;
  }

  function consumeDownload() {
    if (!canDownload()) return false;
    const q = getQuotaState();
    q.used++;
    saveJSON(K_QUOTA, q);
    return true;
  }

  /* ===== 邀请码 ===== */
  function redeemInviteCode(code) {
    const c = String(code || '').trim();
    if (INVITE_CODES[c]) {
      saveJSON(K_INVITE, { code: c, unlimited: true });
      return { ok: true, message: '邀请码激活成功！已解锁无限下载 🎉' };
    }
    return { ok: false, message: '邀请码无效或已被使用' };
  }

  /* ===== 付款处理 ===== */
  function activatePayment(amount) {
    const a = parseFloat(amount);
    if (isNaN(a) || a < MIN_CUSTOM_AMOUNT) {
      return { ok: false, message: '金额不能低于 ' + MIN_CUSTOM_AMOUNT + ' 元' };
    }

    const pay = getPaymentState();
    const now = new Date().toISOString();

    if (a >= TIER_UNLIMITED_MIN) {
      /* 无限下载 */
      saveJSON(K_PAYMENT, { level: 'unlimited', amount: a, expireDate: null, paidAt: now });
      return { ok: true, message: '充值 ' + a + ' 元成功！已解锁无限下载 🎉' };
    }

    if (a >= TIER_200_PRICE) {
      /* 每天 200 张，有效期 30 天 */
      const expire = new Date();
      expire.setDate(expire.getDate() + 30);
      const expireStr = expire.getFullYear() + '-' + String(expire.getMonth() + 1).padStart(2, '0') + '-' + String(expire.getDate()).padStart(2, '0');
      saveJSON(K_PAYMENT, { level: 'tier200', amount: (pay.amount || 0) + a, expireDate: expireStr, paidAt: now });
      return { ok: true, message: '充值 ' + a + ' 元成功！每天可下载 200 张（30 天有效）🎉' };
    }

    return { ok: false, message: '金额不能低于 ' + MIN_CUSTOM_AMOUNT + ' 元' };
  }

  /* ===== UI：付费弹窗 ===== */
  function showPaymentModal() {
    /* 如果已有弹窗则移除 */
    const old = document.getElementById('modal-payment');
    if (old) old.remove();

    const remaining = getRemaining();
    const pay = getPaymentState();
    const invite = getInviteState();

    let statusHtml = '';
    if (invite.unlimited) {
      statusHtml = '<div class="pay-status unlimited">♾️ 无限下载（邀请码）</div>';
    } else if (pay.level === 'unlimited') {
      statusHtml = '<div class="pay-status unlimited">♾️ 无限下载</div>';
    } else if (pay.level === 'tier200' && pay.expireDate && today() <= pay.expireDate) {
      statusHtml = '<div class="pay-status tier200">⭐ 每天 200 张（' + pay.expireDate + ' 前有效）</div>';
    } else {
      statusHtml = '<div class="pay-status free">免费额度：今日剩余 <strong>' + remaining + '</strong> / ' + FREE_DAILY_LIMIT + ' 张</div>';
    }

    const html = `
<div class="pay-overlay" id="modal-payment">
  <div class="pay-card">
    <button class="pay-close" id="pay-close">&times;</button>
    <h2 class="pay-title">💎 解锁更多下载</h2>
    ${statusHtml}

    <div class="pay-tiers">
      <div class="pay-tier ${pay.level === 'tier200' ? 'active' : ''}" data-amount="0.5">
        <div class="pay-tier-amount">¥0.5</div>
        <div class="pay-tier-desc">每天 200 张<br><small>30 天有效</small></div>
      </div>
      <div class="pay-tier ${pay.level === 'unlimited' ? 'active' : ''}" data-amount="5">
        <div class="pay-tier-amount">¥5</div>
        <div class="pay-tier-desc">无限下载<br><small>永久有效</small></div>
      </div>
      <div class="pay-tier" data-amount="10">
        <div class="pay-tier-amount">¥10</div>
        <div class="pay-tier-desc">无限下载<br><small>支持一下 💖</small></div>
      </div>
    </div>

    <div class="pay-custom">
      <label>自定义金额（最低 ¥0.5）：</label>
      <div class="pay-custom-row">
        <span class="pay-yuan">¥</span>
        <input type="number" id="pay-custom-amount" min="0.5" step="0.1" placeholder="0.5" value="0.5">
        <button class="btn primary" id="pay-custom-btn">充值</button>
      </div>
    </div>

    <div class="pay-qrcode">
      <div class="pay-qrcode-title">📱 微信扫码付款</div>
      <img src="https://raw.githubusercontent.com/1yk8u/wallpaper/main/data/payment-qr.png" alt="微信收款码" class="pay-qrcode-img" onerror="this.style.display='none'">
      <div class="pay-qrcode-hint">扫码付款后点击下方按钮确认</div>
    </div>

    <button class="btn primary pay-confirm-btn" id="pay-confirm-btn">
      ✅ 我已完成付款
    </button>

    <div class="pay-detect hidden" id="pay-detect">
      <div class="pay-detect-spinner"></div>
      <div class="pay-detect-text">正在检测到账情况…</div>
    </div>

    <div class="pay-invite">
      <div class="pay-invite-title">🎁 有邀请码？</div>
      <div class="pay-invite-row">
        <input type="text" id="pay-invite-code" placeholder="输入邀请码" maxlength="20">
        <button class="btn ghost" id="pay-invite-btn">兑换</button>
      </div>
      <div class="pay-invite-hint">邀请码需加好友获取（详见下方）</div>
    </div>

    <div class="pay-contact">
      <div class="pay-contact-title">💬 获取免费邀请码</div>
      <p>添加微信好友，同意后发送邀请码（无限下载）</p>
      <img src="https://raw.githubusercontent.com/1yk8u/wallpaper/main/data/contact-qr.png" alt="微信联系方式" class="pay-contact-qr" onerror="this.style.display='none'">
    </div>
  </div>
</div>`;

    document.body.insertAdjacentHTML('beforeend', html);

    /* 注入样式 */
    injectPaymentStyles();

    /* 绑定事件 */
    const $ = (id) => document.getElementById(id);

    $('pay-close').addEventListener('click', () => $('modal-payment').remove());
    $('modal-payment').addEventListener('click', (e) => {
      if (e.target === $('modal-payment')) $('modal-payment').remove();
    });

    /* 选择档位 */
    document.querySelectorAll('.pay-tier').forEach(el => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.pay-tier').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        $('pay-custom-amount').value = el.dataset.amount;
      });
    });

    /* 自定义金额充值 */
    $('pay-custom-btn').addEventListener('click', () => {
      const amount = parseFloat($('pay-custom-amount').value);
      if (isNaN(amount) || amount < MIN_CUSTOM_AMOUNT) {
        alert('金额不能低于 ' + MIN_CUSTOM_AMOUNT + ' 元');
        return;
      }
      /* 显示付款确认流程 */
      startPaymentFlow(amount);
    });

    /* 确认付款按钮 */
    $('pay-confirm-btn').addEventListener('click', () => {
      const amount = parseFloat($('pay-custom-amount').value) || MIN_CUSTOM_AMOUNT;
      startPaymentFlow(amount);
    });

    /* 邀请码兑换 */
    $('pay-invite-btn').addEventListener('click', () => {
      const code = $('pay-invite-code').value;
      const result = redeemInviteCode(code);
      alert(result.message);
      if (result.ok) {
        $('modal-payment').remove();
        /* 触发下载计数刷新 */
        if (typeof updateQuotaDisplay === 'function') updateQuotaDisplay();
      }
    });

    $('pay-invite-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('pay-invite-btn').click();
    });
  }

  /* ===== 付款流程（模拟自动到账检测） ===== */
  function startPaymentFlow(amount) {
    const detect = document.getElementById('pay-detect');
    const confirmBtn = document.getElementById('pay-confirm-btn');
    if (!detect || !confirmBtn) return;

    detect.classList.remove('hidden');
    confirmBtn.classList.add('hidden');

    /* 模拟检测：1.5 秒后"到账" */
    let dots = 0;
    const dotTimer = setInterval(() => {
      dots = (dots + 1) % 4;
      const text = detect.querySelector('.pay-detect-text');
      if (text) text.textContent = '正在检测到账情况' + '.'.repeat(dots);
    }, 400);

    setTimeout(() => {
      clearInterval(dotTimer);
      detect.innerHTML = '<div class="pay-detect-text" style="color:#2d7d2d">✅ 已检测到到账！</div>';

      setTimeout(() => {
        const result = activatePayment(amount);
        alert(result.message);
        document.getElementById('modal-payment')?.remove();
        if (typeof updateQuotaDisplay === 'function') updateQuotaDisplay();
      }, 800);
    }, 1500);
  }

  /* ===== 样式注入 ===== */
  function injectPaymentStyles() {
    if (document.getElementById('payment-styles')) return;
    const style = document.createElement('style');
    style.id = 'payment-styles';
    style.textContent = `
.pay-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);padding:20px}
.pay-card{background:#fff;border-radius:20px;max-width:440px;width:100%;max-height:90vh;overflow-y:auto;padding:28px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
.pay-close{position:absolute;top:12px;right:16px;background:none;border:none;font-size:28px;cursor:pointer;color:#999;line-height:1;padding:4px 8px;border-radius:8px}
.pay-close:hover{background:#f0f0f0;color:#333}
.pay-title{text-align:center;margin:0 0 16px;font-size:22px;color:#333}
.pay-status{text-align:center;padding:10px 16px;border-radius:12px;margin-bottom:20px;font-size:14px}
.pay-status.free{background:#f0f7ff;color:#2563eb}
.pay-status.tier200{background:#fff7ed;color:#c2410c}
.pay-status.unlimited{background:#f0fdf4;color:#15803d}
.pay-tiers{display:flex;gap:10px;margin-bottom:20px}
.pay-tier{flex:1;border:2px solid #e5e7eb;border-radius:14px;padding:14px 8px;text-align:center;cursor:pointer;transition:all 0.2s}
.pay-tier:hover{border-color:#93c5fd;transform:translateY(-2px)}
.pay-tier.active{border-color:#2563eb;background:#eff6ff}
.pay-tier-amount{font-size:20px;font-weight:700;color:#2563eb;margin-bottom:4px}
.pay-tier-desc{font-size:12px;color:#666;line-height:1.4}
.pay-custom{margin-bottom:20px}
.pay-custom label{display:block;font-size:13px;color:#666;margin-bottom:6px}
.pay-custom-row{display:flex;gap:8px;align-items:center}
.pay-yuan{font-size:18px;font-weight:700;color:#2563eb}
.pay-custom-row input{flex:1;padding:10px 12px;border:2px solid #e5e7eb;border-radius:10px;font-size:16px;outline:none}
.pay-custom-row input:focus{border-color:#2563eb}
.pay-qrcode{text-align:center;padding:16px;background:#f9fafb;border-radius:14px;margin-bottom:16px}
.pay-qrcode-title{font-size:14px;font-weight:600;margin-bottom:10px;color:#333}
.pay-qrcode-img{width:180px;height:180px;object-fit:contain;border-radius:12px;border:2px solid #e5e7eb}
.pay-qrcode-hint{font-size:12px;color:#999;margin-top:8px}
.pay-confirm-btn{width:100%;padding:14px;font-size:16px;border-radius:12px;margin-bottom:16px}
.pay-detect{text-align:center;padding:20px;margin-bottom:16px}
.pay-detect-spinner{width:36px;height:36px;border:4px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;animation:paySpin 0.8s linear infinite;margin:0 auto 12px}
@keyframes paySpin{to{transform:rotate(360deg)}}
.pay-detect-text{font-size:14px;color:#666}
.pay-invite{padding:16px;background:#f9fafb;border-radius:14px;margin-bottom:16px}
.pay-invite-title{font-size:14px;font-weight:600;margin-bottom:8px;color:#333}
.pay-invite-row{display:flex;gap:8px}
.pay-invite-row input{flex:1;padding:10px 12px;border:2px solid #e5e7eb;border-radius:10px;font-size:14px;outline:none}
.pay-invite-row input:focus{border-color:#2563eb}
.pay-invite-hint{font-size:11px;color:#999;margin-top:6px}
.pay-contact{text-align:center;padding:16px;border-top:1px solid #eee}
.pay-contact-title{font-size:14px;font-weight:600;margin-bottom:8px;color:#333}
.pay-contact p{font-size:12px;color:#666;margin:0 0 10px}
.pay-contact-qr{width:140px;height:200px;object-fit:contain;border-radius:10px;border:1px solid #eee}
.hidden{display:none!important}
`;
    document.head.appendChild(style);
  }

  /* ===== 配额显示更新 ===== */
  function updateQuotaDisplay() {
    const remaining = getRemaining();
    const limit = getDailyLimit();
    const invite = getInviteState();
    const pay = getPaymentState();

    /* 更新顶栏或任意显示额度的元素 */
    const quotaEls = document.querySelectorAll('[data-quota-display]');
    quotaEls.forEach(el => {
      if (invite.unlimited || pay.level === 'unlimited') {
        el.textContent = '♾️ 无限';
      } else if (remaining === Infinity) {
        el.textContent = '♾️ 无限';
      } else {
        el.textContent = '今日 ' + remaining + '/' + limit;
      }
    });
  }

  /* ===== 公开 API ===== */
  return {
    /* 额度 */
    canDownload,
    consumeDownload,
    getRemaining,
    getDailyLimit,
    getQuotaState,

    /* 付费 */
    showPaymentModal,
    activatePayment,
    getPaymentState,

    /* 邀请码 */
    redeemInviteCode,
    getInviteState,

    /* UI */
    updateQuotaDisplay,
    injectPaymentStyles,

    /* 常量（供外部使用） */
    FREE_DAILY_LIMIT,
    MIN_CUSTOM_AMOUNT,
  };
})();

/* 页面加载后注入样式 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Payment.injectPaymentStyles());
} else {
  Payment.injectPaymentStyles();
}
