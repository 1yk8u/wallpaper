/* =====================================================================
 * parsehub.js —— 解析页：两个第三方工具 + 结果回收入库
 *
 *   vtool.tv    https://vtool.tv/zh/download/<platform>
 *   HelloTik    https://www.hellotik.app/zh/<platform>
 *
 * 两个站点 X-Frame-Options: DENY，不能 iframe；其 /api/parse 需要页面票据
 * 且不允许跨域，本站无法直接代抓。因此流程为：
 *   粘贴链接 → 点工具（新窗口，自动复制链接）→ 用户在工具页复制结果
 *   → 切回本页 → 自动读剪贴板 / 粘贴 / 选文件 → 解析区下方弹出
 *   「是否保存到壁纸库」→ 确认后走 WPGH.importEntries 永久入库
 *
 * 浏览器安全沙箱不允许读取其它标签页内容，所以「复制一下」这一步无法省掉；
 * 本站把其余步骤全部自动化，切回来通常无需任何点击即可弹窗。
 * ===================================================================== */
'use strict';

const ParseHub = (() => {
  /* 平台识别 → 两个工具的路径片段 */
  const PLATS = [
    { k: 'douyin',      n: '抖音',       re: /douyin\.com|iesdouyin/i,                    vt: 'douyin',      ht: 'douyin' },
    { k: 'kuaishou',    n: '快手',       re: /kuaishou|chenzhongtech/i,                    vt: 'kuaishou',    ht: 'kuaishou' },
    { k: 'bilibili',    n: '哔哩哔哩',   re: /bilibili\.com|b23\.tv/i,                     vt: 'bilibili',    ht: 'bilibili' },
    { k: 'xiaohongshu', n: '小红书',     re: /xiaohongshu|xhslink/i,                       vt: 'xiaohongshu', ht: 'rednote' },
    { k: 'tiktok',      n: 'TikTok',     re: /tiktok\.com/i,                                vt: 'tiktok',      ht: 'tiktok' },
    { k: 'youtube',     n: 'YouTube',    re: /youtube\.com|youtu\.be/i,                    vt: 'youtube',      ht: '' },
    { k: 'weibo',       n: '微博',       re: /weibo\.com|weibo\.cn/i,                      vt: 'weibo',        ht: '' },
    { k: 'instagram',   n: 'Instagram',  re: /instagram\.com/i,                            vt: 'instagram',    ht: '' },
    { k: 'x',           n: 'X / Twitter',re: /(^|\.)(x|twitter)\.com/i,                    vt: 'x',            ht: '' },
    { k: 'pinterest',   n: 'Pinterest',  re: /pinterest\./i,                               vt: 'pinterest',    ht: '' },
    { k: 'reddit',      n: 'Reddit',     re: /reddit\.com/i,                               vt: 'reddit',       ht: '' },
    { k: 'facebook',    n: 'Facebook',   re: /facebook\.com|fb\.watch/i,                   vt: 'facebook',     ht: '' },
    { k: 'vimeo',       n: 'Vimeo',      re: /vimeo\.com/i,                                vt: 'vimeo',        ht: '' },
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

  /* ===================== 结果回收 ===================== */
  /* 分享页 / 工具页链接：不算图片结果 */
  const PAGE_RE = /(v\.douyin|iesdouyin|vtool\.tv|hellotik|b23\.tv|bilibili\.com\/video|xhslink|xiaohongshu\.com\/explore|music\.163|y\.qq\.com|kugou|qishui|kuaishou\.com\/(profile|short-video|f\/)|tiktok\.com\/@|youtube\.com\/watch|youtu\.be\/)/i;
  /* 明确的媒体扩展名（可带 query / hash） */
  const MEDIA_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|mp4|mov|m4v|webm)(?:[?#]|$)/i;
  /* 常见图片 CDN / 下载链路特征 */
  const CDN_RE = /(hdslb|xhscdn|byteimg|douyinpic|tos-cn|alicdn|qpic|sinaimg|126\.net|kuaishou.*(img|image)|img[0-9]?\.|\/obj\/|\/image|\/photo|\/picture|download|cdn)/i;
  const URL_ALL_RE = /https?:\/\/[^\s"'<>,，。；;）)\]】]+/gi;

  /* 纯函数：从任意文本里挑出「图片 / 视频直链」，去重、限 30 条。供自测直接调用 */
  function collectURLs(text) {
    const raw = String(text || '').match(URL_ALL_RE) || [];
    const out = [];
    const seen = new Set();
    for (let u of raw) {
      u = u.replace(/[.,;:!?。，；！？、)+]+$/, '').replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(u)) continue;
      /* 分享页 / 工具页链接排除；但工具站给出的「下载 / 代理 / 媒体文件」链接要留下 */
      if (PAGE_RE.test(u) && !MEDIA_RE.test(u) && !/(download|file|proxy|media)/i.test(u)) continue;
      if (!MEDIA_RE.test(u) && !CDN_RE.test(u)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= 30) break;
    }
    return out;
  }

  const isVideo = u => /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(u || '') || /\/video\/|\.mp4/i.test(u || '');
  function extOf(u, file, blobType) {
    const m = String(u || '').match(/\.(jpe?g|png|webp|gif|bmp|avif|heic|mp4|mov|m4v|webm)(?:[?#]|$)/i);
    if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
    const fn = file && file.name ? String(file.name).match(/\.[a-z0-9]{2,5}$/i) : null;
    if (fn) return fn[0].toLowerCase();
    const t = String(blobType || (file && file.type) || '');
    if (/png/i.test(t)) return '.png';
    if (/webp/i.test(t)) return '.webp';
    if (/gif/i.test(t)) return '.gif';
    if (/mp4|video/i.test(t)) return '.mp4';
    return '.jpg';
  }
  const safeName = s => String(s || 'parse').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 90);
  function sig(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
  }

  let caught = [];        // [{ url, file?, video }]
  let armed = false;      // 已打开工具页，等待结果
  let lastClip = '';      // 剪贴板去重
  let busy = false;
  let autoTry = 0;

  function state(text, kind) {
    const el = $('ph-catch-state');
    if (!el) return;
    el.className = 'ph-catch-state' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }
  function progress(text, kind) {
    const el = $('ph-progress');
    if (!el) return;
    if (!text) { el.className = 'ph-progress hidden'; el.textContent = ''; return; }
    el.className = 'ph-progress' + (kind ? ' ' + kind : '');
    el.innerHTML = text;
  }
  function msg(text, kind) {
    const el = $('ph-msg');
    if (!el) return;
    el.className = 'ph-msg ' + (kind || 'ok');
    el.textContent = text;
  }

  function render() {
    const box = $('ph-thumbs');
    const ask = $('ph-ask');
    if (!box || !ask) return;
    box.innerHTML = caught.map((it, i) => {
      const src = it.file ? (it._blobURL || '') : it.url;
      const media = it.video
        ? `<span class="ph-thumb-vid">▶</span>`
        : `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer" loading="lazy">`;
      return `<div class="ph-thumb" data-i="${i}">${media}<button class="ph-thumb-x" data-rm="${i}" title="移除">×</button></div>`;
    }).join('');
    /* CDN 防盗链时预览会失败 → 换成占位图标，不留破图 */
    box.querySelectorAll('img').forEach(img => {
      img.addEventListener('error', () => {
        const holder = document.createElement('span');
        holder.className = 'ph-thumb-fail';
        holder.textContent = '🖼';
        holder.title = '预览受限，仍可尝试保存';
        img.replaceWith(holder);
      });
    });
    box.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      const i = +b.getAttribute('data-rm');
      if (caught[i] && caught[i]._blobURL) URL.revokeObjectURL(caught[i]._blobURL);
      caught.splice(i, 1);
      render();
    }));
    const nEl = $('ph-ask-n');
    if (nEl) nEl.textContent = String(caught.length);
    ask.classList.toggle('hidden', caught.length === 0);
    if (caught.length) {
      state('收到 ' + caught.length + ' 个结果 · 等你确认', 'ok');
      const c = $('ph-catch');
      if (c && armed) { armed = false; try { c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {} }
    } else {
      state(armed ? '等待解析结果…' : '等待解析结果…');
    }
  }

  /* 加入结果：URL 或 File，去重 */
  function add(urls, files) {
    let added = 0;
    (urls || []).forEach(u => {
      if (caught.some(x => x.url === u)) return;
      caught.push({ url: u, video: isVideo(u) });
      added++;
    });
    (files || []).forEach(f => {
      if (!f || !(f.type || '').match(/^(image|video)\//i)) return;
      const key = 'file:' + f.name + ':' + f.size;
      if (caught.some(x => x._key === key)) return;
      const blobURL = URL.createObjectURL(f);
      caught.push({ url: blobURL, file: f, _key: key, _blobURL: blobURL, video: /^video\//i.test(f.type) });
      added++;
    });
    if (added) render();
    return added;
  }

  function clear() {
    caught.forEach(x => { if (x._blobURL) try { URL.revokeObjectURL(x._blobURL); } catch (e) {} });
    caught = [];
    lastClip = '';
    render();
    progress('');
  }

  /* 自动读剪贴板：切回本页时静默尝试，权限不足就等用户点按钮 */
  async function autoCollect(silent) {
    if (busy || caught.length) return;
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { }
    if (!text || text === lastClip) return;
    lastClip = text;
    const urls = collectURLs(text);
    if (urls.length) {
      add(urls, []);
      if (!silent) msg('已取回 ' + urls.length + ' 个结果', 'ok');
    }
  }

  async function manualCollect() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { }
    const ta = $('ph-urls');
    if (ta && ta.value.trim()) text += '\n' + ta.value.trim();
    const urls = collectURLs(text);
    const n = add(urls, []);
    if (n) {
      msg('已取回 ' + n + ' 个结果，下面可以确认是否入库', 'ok');
      if (ta) ta.value = '';
    } else {
      const inp = $('ph-urls');
      if (inp) { inp.focus(); inp.placeholder = '没读到图片链接：先在工具页点「复制图片链接」，再点上面的按钮；或直接把图片存下来用「选择图片」'; }
      msg('剪贴板里还没检测到图片直链。在工具页点「复制图片链接 / 复制全部图片」后再切回来，或把图片选进来。', 'warn');
    }
  }

  /* ===================== 入库 / 下载 ===================== */
  async function grabBlob(it, ms) {
    if (it.file) return it.file;
    const u = it.url;
    /* 直连优先：B站 / 小红书 / 多数 CDN 允许跨域读二进制 */
    try {
      const r = await fetch(u, { signal: sig(Math.min(ms, 25000)) });
      if (r.ok) {
        const b = await r.blob();
        if (b.size > 0 && !/^\s*(text\/html|application\/json)/i.test(b.type || '')) return b;
      }
    } catch (e) { }
    if (typeof fetchBlobSmart === 'function') {
      try { return await fetchBlobSmart(u, { ms }); } catch (e) { }
    }
    /* 兜底：图片代理（自动转码，允许跨域） */
    try {
      const host = u.replace(/^https?:\/\//i, '').split('?')[0];
      const p = 'https://images.weserv.nl/?url=' + encodeURIComponent(host) + '&output=jpg';
      const r = await fetch(p, { signal: sig(ms) });
      if (r.ok) { const b = await r.blob(); if (b.size > 1000) return b; }
    } catch (e) { }
    return null;
  }

  function quota(n) {
    if (typeof Payment === 'undefined') return true;
    const rem = Payment.getRemaining ? Payment.getRemaining() : Infinity;
    if (rem !== Infinity && rem < n) {
      if (typeof toast === 'function') toast('今日剩余额度 ' + rem + ' 张，不够保存这 ' + n + ' 张', 'warn');
      if (Payment.showPaymentModal) Payment.showPaymentModal();
      return false;
    }
    for (let i = 0; i < n; i++) {
      if (Payment.consumeDownload && !Payment.consumeDownload()) return false;
    }
    if (Payment.updateQuotaDisplay) Payment.updateQuotaDisplay();
    return true;
  }

  async function saveToLibrary() {
    if (busy || !caught.length) return;
    if (typeof WPGH === 'undefined' || !WPGH.cfg || !WPGH.cfg.pat) {
      msg('壁纸库连接不可用：页面脚本没加载完整，请刷新后重试', 'warn');
      return;
    }
    const list = caught.slice();
    if (!quota(list.length)) return;
    busy = true;
    const yes = $('ph-yes'); if (yes) yes.disabled = true;
    /* 清单由 Actions 从文件名生成标题 → 文件名要可读，且每张不重名 */
    const srcPlat = detect(extractURL(($('ph-link') || {}).value || ''));
    const label = (srcPlat ? srcPlat.n : '解析') + '收藏_' +
      new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_';
    const title = label.replace(/_/g, ' ').trim();
    const entries = [];
    let fail = 0;
    for (let i = 0; i < list.length; i++) {
      progress('<span class="ph-spin"></span>正在取回 ' + (i + 1) + ' / ' + list.length + ' …');
      try {
        const blob = await grabBlob(list[i], 45000);
        if (!blob) throw new Error('取不到内容');
        const size = blob.size || (list[i].file && list[i].file.size) || 0;
        if (size > 60 * 1024 * 1024) throw new Error('超过 60MB');
        entries.push({
          name: safeName(label + (i + 1)) + extOf(list[i].url, list[i].file, blob.type),
          bytes: new Uint8Array(await blob.arrayBuffer()),
          size,
          itemExtra: { title: title + (i + 1) },
        });
      } catch (e) { fail++; }
    }
    if (!entries.length) {
      busy = false; if (yes) yes.disabled = false;
      progress('没能取回图片内容（该平台 CDN 可能禁止跨域）。建议用「选择图片」把已保存的图片上传，或点「只下载到设备」。', 'bad');
      return;
    }
    progress('<span class="ph-spin"></span>已取回 ' + entries.length + ' 个，正在提交到壁纸库…');
    try {
      const committed = await WPGH.importEntries(entries, {
        onStatus: (idx, text) => progress('<span class="ph-spin"></span>' + (idx + 1) + ' / ' + entries.length + ' · ' + esc(text)),
      });
      try { committed.forEach(it => allItems.unshift(it)); } catch (e) { }
      try { if (typeof renderAll === 'function') renderAll(); } catch (e) { }
      clear();
      progress('已保存 ' + committed.length + ' 张到壁纸库' + (fail ? '（' + fail + ' 张未取到）' : '') + ' · 去「壁纸」页刷新即可看到 ✅', 'ok');
      state('已入库 ' + committed.length + ' 张', 'ok');
      if (typeof toast === 'function') toast('已保存到壁纸库', 'ok');
      msg('保存完成！图片已永久存入仓库，约 1~2 分钟后全网可见。', 'ok');
    } catch (e) {
      progress('提交仓库失败：' + esc(e.message || e) + '。可先点「只下载到设备」保住图片。', 'bad');
    } finally {
      busy = false; if (yes) yes.disabled = false;
    }
  }

  async function downloadOnly() {
    if (busy || !caught.length) return;
    const list = caught.slice();
    if (!quota(list.length)) return;
    busy = true;
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      progress('<span class="ph-spin"></span>下载 ' + (i + 1) + ' / ' + list.length + ' …');
      try {
        const b = await grabBlob(list[i], 45000);
        if (!b) throw new Error('no blob');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = safeName('解析图片-' + (i + 1)) + extOf(list[i].url, list[i].file, b.type);
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        ok++;
      } catch (e) { }
    }
    busy = false;
    progress('已开始保存 ' + ok + ' / ' + list.length + ' 个到设备' + (ok < list.length ? '（其余 CDN 限制跨域，请到工具页手动下载）' : ''), ok ? 'ok' : 'bad');
  }

  /* ===================== 工具跳转 ===================== */
  function refresh() {
    const url = extractURL(($('ph-link') || {}).value);
    const d = $('ph-detected');
    if (!d) return;
    if (!url) { d.className = 'ph-detected'; d.textContent = '等待粘贴链接…'; return; }
    const p = detect(url);
    d.className = 'ph-detected ok';
    d.textContent = p
      ? '已识别：' + p.n + ' · 点下面任意工具，解析完切回来会自动弹保存确认'
      : '已识别到链接 · 点下面任意工具，解析完切回来会自动弹保存确认';
  }

  async function go(kind) {
    const raw = ($('ph-link') || {}).value || '';
    const url = extractURL(raw);
    if (!url) { msg('先把分享链接粘贴到输入框里～', 'warn'); return; }
    const p = detect(url);
    const target = toolURL(kind, url, p);
    const name = kind === 'vtool' ? 'vtool.tv' : 'HelloTik';

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
    /* 等待结果：清空上一批、记住当前剪贴板，避免把原链接误判成结果 */
    clear();
    armed = true;
    lastClip = url;
    autoTry = 0;
    state('已打开 ' + name + ' · 等待解析结果…', 'wait');

    const win = window.open(target, '_blank', 'noopener');
    if (!win) {
      msg('浏览器拦截了新窗口。链接已复制，请手动打开 ' + name + ' 粘贴，或允许本页弹窗后重试。', 'warn');
      return;
    }
    msg('已打开 ' + name + (p ? '（' + p.n + ' 专属页）' : '') + '。粘贴解析后，复制图片链接再切回本页，下方会自动弹出「是否保存到壁纸库」。', 'ok');
  }

  /* ===================== 样式 ===================== */
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
/* ---- 结果回收 ---- */
.ph-catch{margin:14px 0 4px;border:1.5px dashed #c7d6f5;background:linear-gradient(180deg,#f8fbff,#fff);border-radius:16px;padding:14px}
.ph-catch-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.ph-catch-title{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:800;color:#1e3a8a}
.ph-catch-title svg{width:17px;height:17px}
.ph-catch-state{font-size:11px;color:#8a94a6;background:#eef2f9;border-radius:999px;padding:5px 10px}
.ph-catch-state.wait{color:#b45309;background:#fff7ed}
.ph-catch-state.ok{color:#15803d;background:#dcfce7;font-weight:700}
.ph-catch-tip{font-size:11px;line-height:1.6;color:#7b8798;margin:9px 0 11px}
.ph-catch-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.ph-catch-actions .btn{font-size:12px;padding:9px 13px;border-radius:10px;cursor:pointer}
.ph-filebtn{display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.ph-urls{width:100%;box-sizing:border-box;border:1px solid #e3e9f2;border-radius:10px;padding:9px 11px;font-size:12px;line-height:1.5;resize:vertical;background:#fff;color:#1f2937;outline:none}
.ph-urls:focus{border-color:#93b4ff;box-shadow:0 0 0 3px rgba(37,99,235,.08)}
.ph-thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.ph-thumbs:empty{display:none}
.ph-thumb{position:relative;width:72px;height:72px;border-radius:10px;overflow:hidden;border:1px solid #e3e9f2;background:#f1f5fb;flex:none}
.ph-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ph-thumb-fail{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:22px;background:#eef2f9;color:#94a3b8}
.ph-thumb-vid{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#2563eb;font-size:22px;background:linear-gradient(135deg,#e0e7ff,#f1f5ff)}
.ph-thumb-x{position:absolute;top:2px;right:2px;width:19px;height:19px;line-height:17px;text-align:center;border:0;border-radius:50%;background:rgba(17,24,39,.62);color:#fff;font-size:14px;cursor:pointer;padding:0}
.ph-ask{margin-top:12px;border:1.5px solid #bfdbfe;background:#eff6ff;border-radius:13px;padding:13px;animation:phPop .22s ease-out}
@keyframes phPop{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.ph-ask-txt{font-size:13px;line-height:1.6;color:#1e3a8a;margin:0 0 11px}
.ph-ask-txt b{color:#1d4ed8}
.ph-ask-txt small{display:block;font-size:11px;color:#6b7c9c;font-weight:400;margin-top:2px}
.ph-ask-btns{display:flex;gap:8px;flex-wrap:wrap}
.ph-ask-btns .btn{font-size:12px;padding:9px 13px;border-radius:10px;cursor:pointer}
.ph-ask-btns .btn:disabled{opacity:.55;cursor:wait}
.ph-progress{font-size:12px;line-height:1.6;border-radius:10px;padding:10px 12px;margin-top:10px;background:#f1f5f9;color:#475569}
.ph-progress.ok{background:#f0fdf4;color:#15803d}
.ph-progress.bad{background:#fef2f2;color:#b91c1c}
.ph-spin{display:inline-block;width:11px;height:11px;border:2px solid #c7d2fe;border-top-color:#2563eb;border-radius:50%;animation:phSpin .7s linear infinite;vertical-align:-1px;margin-right:5px}
@keyframes phSpin{to{transform:rotate(360deg)}}
@media(max-width:480px){.ph-tool{padding:12px;gap:10px}.ph-logo{width:38px;height:38px;font-size:19px}.ph-txt b{font-size:15px}.ph-thumb{width:62px;height:62px}.ph-catch{padding:12px}}
`;
    document.head.appendChild(s);
  }

  /* ===================== 事件绑定 ===================== */
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
      } catch (e) { input.focus(); msg('读不到剪贴板（权限限制），请长按输入框手动粘贴', 'warn'); }
    });
    const clr = $('ph-clear');
    if (clr) clr.addEventListener('click', () => {
      if (input) input.value = '';
      refresh(); clear();
      const m = $('ph-msg'); if (m) m.classList.add('hidden');
      armed = false; state('等待解析结果…');
    });
    const v = $('ph-vtool'); if (v) v.addEventListener('click', () => go('vtool'));
    const h = $('ph-hello'); if (h) h.addEventListener('click', () => go('hello'));

    const collect = $('ph-collect'); if (collect) collect.addEventListener('click', manualCollect);
    const yes = $('ph-yes'); if (yes) yes.addEventListener('click', saveToLibrary);
    const dl = $('ph-dl'); if (dl) dl.addEventListener('click', downloadOnly);
    const no = $('ph-no'); if (no) no.addEventListener('click', () => { clear(); state('已忽略，可继续解析下一批'); });

    /* 选择本地图片 / 视频 */
    const file = $('ph-file');
    if (file) file.addEventListener('change', () => {
      const n = add([], Array.from(file.files || []));
      if (n) { state('收到 ' + n + ' 个本地文件 · 等你确认', 'ok'); msg('已加入 ' + n + ' 个文件，下面确认是否保存到壁纸库', 'ok'); }
      file.value = '';
    });

    /* 直链输入框 */
    const ta = $('ph-urls');
    if (ta) ta.addEventListener('input', () => {
      const urls = collectURLs(ta.value);
      if (!urls.length) return;
      const n = add(urls, []);
      if (n) { ta.value = ''; ta.placeholder = '还可以继续粘贴更多图片直链…'; }
    });

    /* 全局粘贴：文本直链 + 直接粘贴图片本身 */
    document.addEventListener('paste', e => {
      const target = e.target || {};
      const inField = /^(INPUT|TEXTAREA)$/i.test(target.tagName || '');
      const files = [];
      try {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file' && /^(image|video)\//i.test(items[i].type || '')) {
            const f = items[i].getAsFile(); if (f) files.push(f);
          }
        }
        if (!files.length && e.clipboardData && e.clipboardData.files) {
          for (const f of e.clipboardData.files) if (/^(image|video)\//i.test(f.type || '')) files.push(f);
        }
      } catch (err) {}
      const txt = (e.clipboardData && e.clipboardData.getData('text')) || '';
      const urls = collectURLs(txt);
      /* 若粘的是分享链接到主输入框，交给原有 refresh，不干扰 */
      if (inField && target.id === 'ph-link' && !urls.length && !files.length) return;
      if (urls.length || files.length) {
        const n = add(urls, files);
        if (n) {
          if (inField && target.id === 'ph-urls') { try { e.preventDefault(); } catch (err) {} target.value = ''; }
          msg('已收到 ' + n + ' 个结果，下面确认是否保存到壁纸库', 'ok');
        }
      }
    });

    /* 拖入图片 */
    const catchBox = $('ph-catch');
    if (catchBox) {
      catchBox.addEventListener('dragover', e => { e.preventDefault(); catchBox.style.borderColor = '#2563eb'; });
      catchBox.addEventListener('dragleave', () => { catchBox.style.borderColor = ''; });
      catchBox.addEventListener('drop', e => {
        e.preventDefault(); catchBox.style.borderColor = '';
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        const urls = collectURLs((e.dataTransfer && e.dataTransfer.getData('text')) || '');
        const n = add(urls, files);
        if (n) msg('已加入 ' + n + ' 个结果', 'ok');
      });
    }

    /* 切回本页自动读剪贴板：多次延迟尝试，命中即弹窗 */
    const onReturn = () => {
      if (!armed || caught.length || busy) return;
      autoTry++;
      [250, 1100, 2600].forEach(ms => setTimeout(() => autoCollect(true), ms));
      if (autoTry > 8) armed = false;
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onReturn(); });

    refresh();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { go, detect, toolURL, collectURLs, add, clear, PLATS, get caught() { return caught; } };
})();
