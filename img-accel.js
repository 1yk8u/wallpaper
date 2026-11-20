/* =====================================================================
 * img-accel.js —— 图片自动检测加速（内置，零配置）
 *
 * 原理：同一个文件在多个通道都有副本，各通道在国内速度差异极大
 *   - 同源 Pages：稳但有时慢
 *   - raw.githubusercontent.com：通常快，偶尔被限速
 *   - jsdelivr CDN：备选
 * 本模块：
 *   1. 图片超过 N 秒没加载出来 → 自动切换到下一个通道重试
 *   2. load 失败 → 立即换通道
 *   3. 记录每个用户的"最快通道"，下次同类图片优先用它（localStorage）
 *
 * 用法：图片用 data-src 存真实相对路径，加 class="accel-img"。
 *       模块会在图片进入视口时开始加载 + 计时 + 自动切换。
 * ===================================================================== */
(function () {
  'use strict';

  const CHANNELS = {
    local: function (p) { return p; },                                  // 同源（相对路径）
    raw: function (p) {
      return 'https://raw.githubusercontent.com/1yk8u/wallpaper/main/' + p;
    },
    jsd: function (p) {
      return 'https://cdn.jsdelivr.net/gh/1yk8u/wallpaper@main/' + p;
    },
  };
  const ORDER_DEFAULT = ['raw', 'local', 'jsd'];  // 先试 raw（实测多数更快）
  const TIMEOUT = 5000;       // 每张图每通道最多等 5 秒
  const SPEED_KEY = 'wp_img_accel_speed_v1';

  /* 每个用户记住哪个通道最快：{ raw: 平均耗时ms, local: ... } */
  let speed = {};
  try { speed = JSON.parse(localStorage.getItem(SPEED_KEY) || '{}') || {}; } catch (e) {}

  function bestOrder() {
    // 有测速数据就按快的排前面；没数据用默认
    const keys = Object.keys(CHANNELS);
    if (!keys.some(k => typeof speed[k] === 'number')) return ORDER_DEFAULT.slice();
    return keys.slice().sort((a, b) => (speed[a] ?? 99999) - (speed[b] ?? 99999));
  }

  function recordSpeed(ch, ms) {
    // 只记录 < TIMEOUT 的成功样本，滑动平均
    if (ms >= TIMEOUT || ms <= 0) return;
    const prev = speed[ch];
    speed[ch] = typeof prev === 'number' ? Math.round(prev * 0.7 + ms * 0.3) : ms;
    try { localStorage.setItem(SPEED_KEY, JSON.stringify(speed)); } catch (e) {}
  }

  function encode(p) {
    return String(p || '').replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  const started = new WeakSet();

  function loadOne(img) {
    if (started.has(img)) return;
    started.add(img);
    const path = img.getAttribute('data-src') || img.getAttribute('src');
    if (!path || /^data:/.test(path)) return;

    const order = bestOrder();
    let idx = 0;
    const t0 = performance.now();

    function tryNext() {
      if (idx >= order.length) {
        // 全通道失败：显示一个占位 SVG，不留白框
        img.classList.add('accel-failed');
        return;
      }
      const ch = order[idx++];
      const url = /^https?:\/\//i.test(path) ? path : CHANNELS[ch](encode(path));
      const stamp = performance.now();

      const probe = new Image();
      let done = false;
      const cleanup = function () {
        probe.onload = probe.onerror = null;
        clearTimeout(timer);
      };
      const ok = function () {
        if (done) return; done = true; cleanup();
        recordSpeed(ch, Math.round(performance.now() - stamp));
        img.src = url;
        img.classList.add('wp-loaded');
        img.classList.remove('accel-failed');
      };
      const fail = function () {
        if (done) return; done = true; cleanup();
        tryNext();
      };
      probe.onload = ok;
      probe.onerror = fail;
      const timer = setTimeout(fail, TIMEOUT);
      probe.src = url;
    }
    tryNext();
  }

  /* 用 IntersectionObserver：进入视口才开始，避免一次性打满请求 */
  let io = null;
  function observe(img) {
    if (!('IntersectionObserver' in window)) { loadOne(img); return; }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { loadOne(e.target); io.unobserve(e.target); }
        });
      }, { rootMargin: '300px' });
    }
    io.observe(img);
  }

  function scan() {
    document.querySelectorAll('img.accel-img:not(.wp-loaded)').forEach(function (img) {
      if (!started.has(img)) observe(img);
    });
  }

  // 首屏 + 每次网格重绘后扫描（app.js 的 appendGrid 会主动调 __imgAccelScan）
  window.__imgAccelScan = scan;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else { scan(); }
  /* 不再用 setInterval(scan,1500) 每 1.5 秒全局扫 DOM——老手机持续耗电掉帧。
   * 改用 MutationObserver：只有在真的插入了 accel-img 节点时才扫描一次。 */
  if ('MutationObserver' in window) {
    let scheduled = false;
    const mo = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () { scheduled = false; scan(); }, 60);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
