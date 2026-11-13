/* =====================================================================
 * parsehub.js —— 解析页：只用两个第三方工具
 *   vtool.tv    https://vtool.tv/zh/download/<platform>
 *   HelloTik    https://www.hellotik.app/zh/<platform>
 *
 * 两个站点都设置了 X-Frame-Options: DENY，无法 iframe 嵌入，
 * 因此采用「新窗口打开 + 自动复制链接 + 尽量带 ?url= 预填」的方式。
 * 本站不再派单 GitHub Actions，不再有自研引擎轮询。
 * ===================================================================== */
'use strict';

const ParseHub = (() => {
  /* 平台识别 → 两个工具的路径片段 */
  const PLATS = [
    { k: 'douyin',      n: '抖音',       re: /douyin\.com|iesdouyin/i,                    vt: 'douyin',      ht: 'douyin' },
    { k: 'kuaishou',    n: '快手',       re: /kuaishou|chenzhongtech/i,                    vt: 'kuaishou',    ht: 'kuaishou' },
    { k: 'bilibili',    n: '哔哩哔哩',   re: /bilibili\.com|b23\.tv/i,                     vt: 'bilibili',    ht: 'bilibili' },
    { k: 'xiaohongshu', n: '小红书',     re: /xiaohongshu|xhslink/i,                       vt: 'xiaohongshu', ht: 'rednote' },
    { k: 'tiktok',      n: 'TikTok',     re: /tiktok\.com/i,                               vt: 'tiktok',      ht: 'tiktok' },
    { k: 'youtube',     n: 'YouTube',    re: /youtube\.com|youtu\.be/i,                    vt: 'youtube',     ht: '' },
    { k: 'weibo',       n: '微博',       re: /weibo\.com|weibo\.cn/i,                      vt: 'weibo',       ht: '' },
    { k: 'instagram',   n: 'Instagram',  re: /instagram\.com/i,                            vt: 'instagram',   ht: '' },
    { k: 'x',           n: 'X / Twitter',re: /(^|\.)(x|twitter)\.com/i,                    vt: 'x',           ht: '' },
    { k: 'pinterest',   n: 'Pinterest',  re: /pinterest\./i,                               vt: 'pinterest',   ht: '' },
    { k: 'reddit',      n: 'Reddit',     re: /reddit\.com/i,                               vt: 'reddit',      ht: '' },
    { k: 'facebook',    n: 'Facebook',   re: /facebook\.com|fb\.watch/i,                   vt: 'facebook',    ht: '' },
    { k: 'vimeo',       n: 'Vimeo',      re: /vimeo\.com/i,                                vt: 'vimeo',       ht: '' },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function extractURL(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>，。、）)]+/i);
    return m ? m[0] : '';
  }
  function detect(url) {
    return PLATS.find(p => p.re.test(url)) || null;
  }

  function toolURL(kind, url, plat) {
    const q = (url ? '?url=' + encodeURIComponent(url) : '');
    if (kind === 'vtool') {
      return plat && plat.vt
        ? 'https://vtool.tv/zh/download/' + plat.vt + q
        : 'https://vtool.tv/zh' + q;
    }
    return plat && plat.ht
      ? 'https://www.hellotik.app/zh/' + plat.ht + q
      : 'https://www.hellotik.app/zh' + q;
  }

  function styles() {
    if ($('parsehub-styles')) return;
    const s = document.createElement('style');
    s.id = 'parsehub-styles';
    s.textContent = `
.ph-detected{margin:2px 0 14px;font-size:12px;color:#8a94a6;background:#f6f8fc;border:1px solid #e9edf4;border-radius:10px;padding:9px 12px;line-height:1.5}
.ph-detected.ok{color:#1d4ed8;background:#f0f7ff;border-color:#cfe0ff;font-weight:600}
.ph-tools{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.ph-tool{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:2px solid #e5e9f0;background:#fff;border-radius:16px;padding:14px;cursor:pointer;transition:.16s;color:#1f2937}
.ph-tool:hover{border-color:#93b4ff;transform:translateY(-2px);box-shadow:0 8px 22px rgba(37,99,235,.10)}
.ph-tool:active{transform:translateY(0)}
.ph-logo{width:44px;height:44px;border-radius:13px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:800;font-family:ui-sans-serif,system-ui}
.ph-vtool .ph-logo{background:linear-gradient(135deg,#6d5efc,#a855f7)}
.ph-hello .ph-logo{background:linear-gradient(135deg,#ff7a45,#ff4d6d)}
.ph-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ph-txt b{font-size:16px}
.ph-txt small{font-size:11px;color:#8a94a6}
.ph-go{flex:none;font-size:12px;font-weight:700;color:#2563eb;background:#eff6ff;border-radius:999px;padding:7px 11px}
.ph-hello .ph-go{color:#e0435c;background:#fff1f3}
.ph-msg{font-size:12px;line-height:1.6;border-radius:10px;padding:10px 12px;margin-bottom:10px}
.ph-msg.ok{background:#f0fdf4;color:#15803d}
.ph-msg.warn{background:#fff7ed;color:#c2410c}
.hidden{display:none!important}
@media(max-width:480px){.ph-tool{padding:12px;gap:10px}.ph-logo{width:38px;height:38px;font-size:19px}.ph-txt b{font-size:15px}}
`;
    document.head.appendChild(s);
  }

  function msg(text, kind) {
    const el = $('ph-msg');
    if (!el) return;
    el.className = 'ph-msg ' + (kind || 'ok');
    el.textContent = text;
  }

  function refresh() {
    const url = extractURL(($('ph-link') || {}).value);
    const d = $('ph-detected');
    if (!d) return;
    if (!url) {
      d.className = 'ph-detected';
      d.textContent = '等待粘贴链接…';
      return;
    }
    const p = detect(url);
    d.className = 'ph-detected ok';
    d.textContent = p
      ? '已识别：' + p.n + ' · 点下面任意工具即可在新窗口解析（链接已自动复制）'
      : '已识别到链接 · 点下面任意工具，会自动复制并在新窗口打开';
  }

  async function go(kind) {
    const raw = ($('ph-link') || {}).value || '';
    const url = extractURL(raw);
    if (!url) { msg('先把分享链接粘贴到输入框里～', 'warn'); return; }
    const p = detect(url);
    const target = toolURL(kind, url, p);
    const name = kind === 'vtool' ? 'vtool.tv' : 'HelloTik';

    /* 复制到剪贴板：即使 ?url= 预填不生效，用户也能直接粘贴 */
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {}
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch (e) {}
    }

    const win = window.open(target, '_blank', 'noopener');
    if (!win) {
      msg('浏览器拦截了新窗口。链接已复制，请手动打开 ' + name + ' 粘贴，或允许本页弹窗后重试。', 'warn');
      return;
    }
    msg('已打开 ' + name + (p ? '（' + p.n + ' 专属页）' : '') + '。链接'
      + (copied ? '已复制到剪贴板，' : '没复制成功，请手动复制再到工具页') + '粘贴即可解析。', 'ok');
  }

  function init() {
    styles();
    const input = $('ph-link');
    if (input) {
      input.addEventListener('input', refresh);
      input.addEventListener('paste', () => setTimeout(refresh, 80));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') go('vtool'); });
    }
    const paste = $('ph-paste');
    if (paste) paste.addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (!extractURL(t)) { msg('剪贴板里没有链接，先去 App 里复制分享链接', 'warn'); return; }
        input.value = t.trim(); refresh(); msg('已粘贴，点下面的工具即可解析', 'ok');
      } catch (e) {
        input.focus(); msg('读不到剪贴板（权限限制），请长按输入框手动粘贴', 'warn');
      }
    });
    const clear = $('ph-clear');
    if (clear) clear.addEventListener('click', () => {
      if (input) input.value = '';
      refresh();
      const m = $('ph-msg'); if (m) m.classList.add('hidden');
    });
    const v = $('ph-vtool'); if (v) v.addEventListener('click', () => go('vtool'));
    const h = $('ph-hello'); if (h) h.addEventListener('click', () => go('hello'));
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { go, detect, toolURL, PLATS };
})();
