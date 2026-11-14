'use strict';
/* =====================================================================
 * extractor.js —— 自研单链接解析（图片 / 视频 / 音乐路由）
 *
 * 三层链路，全部自研、零第三方：
 *   L1 本机 memo（localStorage，7 天，重复链接秒出）
 *   L2 自家仓库缓存（data/parse-cache.json，经 api.github.com 读取）
 *   L3 自家中转（repository_dispatch → GitHub Actions 代抓 → 轮询取回）
 * ===================================================================== */

const PLATFORMS = {
  douyin:     { name: '抖音',   test: /douyin\.com|iesdouyin\.com/i },
  kuaishou:   { name: '快手',   test: /kuaishou\.com|chenzhongtech/i },
  bilibili:   { name: '哔哩哔哩', test: /bilibili\.com|b23\.tv/i },
  xiaohongshu:{ name: '小红书', test: /xiaohongshu\.com|xhslink\.com/i },
};
function detectPlatform(u) {
  for (const k in PLATFORMS) {
    const p = PLATFORMS[k];
    if (p.test.test(u)) return Object.assign({ key: k }, p);
  }
  return null;
}

/* ---------- 缓存键：必须与 scripts/parse-queue.mjs 逐字节一致 ---------- */
function parseCacheKey(u) {
  const raw = String(u || '').trim().toLowerCase();
  const ne = raw.match(/(?:music\.)?163\.com\/[^\s]*[?&]id=(\d{4,14})/);
  if (ne) return 'netease:' + ne[1];
  const qs = raw.match(/qishui\.douyin\.com\/song\/(\d{6,20})/);
  if (qs) return 'qishui:' + qs[1];
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[?&#]/)[0]
    .replace(/\/+$/, '');
}

/* ---------- L1 本机 memo ---------- */
const MEMO_KEY = 'wp_parse_memo_v1';
function memoRead() {
  try {
    const m = JSON.parse(localStorage.getItem(MEMO_KEY) || '{}');
    const now = Date.now();
    const out = {};
    for (const k in m) if (m[k] && now - (m[k].at || 0) < 7 * 864e5) out[k] = m[k];
    return out;
  } catch (e) { return {}; }
}
function memoPut(url, result) {
  try {
    const m = memoRead();
    const keys = Object.keys(m);
    if (keys.length >= 40) keys.sort((a, b) => (m[a].at || 0) - (m[b].at || 0)).slice(0, keys.length - 39).forEach(k => delete m[k]);
    m[parseCacheKey(url)] = {
      kind: result.kind,
      title: result.title || '', cover: result.cover || '',
      images: (result.images || []).slice(0, 30),
      play: result.play || '',
      at: Date.now(),
    };
    localStorage.setItem(MEMO_KEY, JSON.stringify(m));
  } catch (e) { /* 满了/隐私模式都无所谓 */ }
}
function memoGet(url) {
  const e = memoRead()[parseCacheKey(url)];
  if (!e) return null;
  if (e.kind === 'images' && e.images && e.images.length) return e;
  if (e.kind === 'video' && e.play) return e;
  return null;
}

/* ---------- L2 自家仓库缓存（api.github.com 直读，不等 Pages 重建） ---------- */
let CACHE_TSB = 0, CACHE_BUF = null;
async function serverCacheGet(key, opt) {
  opt = opt || {};
  const bust = Date.now();
  /* 优先 api.github.com（中转一提交这里立刻能看到），失败退回 Pages */
  try {
    const cfg = (typeof WPGH !== 'undefined' && WPGH.cfg) ? WPGH.cfg : null;
    const r = await withTimeout(fetch(
      'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
      '/contents/data/parse-cache.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + bust,
      { headers: { 'Accept': 'application/vnd.github.raw', 'Authorization': 'Bearer ' + cfg.pat } }
    ), opt.ms || 8000);
    if (r.ok) {
      const j = await r.json();
      if (j && j.entries) { CACHE_BUF = j; CACHE_TSB = Date.now(); return j.entries[key] || null; }
    }
  } catch (e) { /* 落到 Pages 源 */ }
  try {
    const r = await withTimeout(fetch('data/parse-cache.json?t=' + bust, { cache: 'no-store' }), opt.ms || 8000);
    if (r.ok) {
      const j = await r.json();
      if (j && j.entries) { CACHE_BUF = j; CACHE_TSB = Date.now(); return j.entries[key] || null; }
    }
  } catch (e) { /* 两路都不通 */ }
  return null;
}

/* ---------- L3 自家中转：寄单 + 轮询 ---------- */
async function relayDispatch(url, key) {
  const cfg = WPGH.cfg;
  const r = await fetch('https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/dispatches', {
    method: 'POST',
    headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + cfg.pat },
    body: JSON.stringify({ event_type: 'parse-request', client_payload: { url: url, key: key } }),
  });
  if (r.status !== 204) throw new Error('派单失败 HTTP ' + r.status);
}
/* 轮询自家仓库缓存：中转提交成功后 api.github.com 立刻可见（无需等 Pages 重建） */
async function relayPoll(key, since, onTick) {
  const t0 = Date.now();
  for (let i = 0; i < 22; i++) {          /* 4s × 22 ≈ 88 秒 */
    await sleep(4000);
    let e = null;
    try {
      const cfg = WPGH.cfg;
      const r = await withTimeout(fetch(
        'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
        '/contents/data/parse-cache.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now(),
        { headers: { 'Accept': 'application/vnd.github.raw', 'Authorization': 'Bearer ' + cfg.pat } }
      ), 8000);
      if (r.ok) {
        const j = await r.json();
        if (j && j.entries) e = j.entries[key] || null;
      }
    } catch (e2) { /* 网络抖动继续等 */ }
    if (e) {
      const ts = Date.parse(e.ts || '') || 0;
      if (ts >= since - 10000) return e;   /* 是这次（或刚覆盖）写入的结果 */
    }
    if (onTick) onTick(i + 1, Math.round((Date.now() - t0) / 1000));
  }
  return null;
}

/* ---------- 状态与结果渲染 ---------- */
function exStatus(text, kind) {
  const el = $id('ex-status');
  if (!el) return;
  if (!text) { el.className = 'ex-status hidden'; el.textContent = ''; return; }
  el.className = 'ex-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}
function exResultHTML(r, plat) {
  const title = esc(r.title || (plat ? plat.name + ' 内容' : '解析结果'));
  let body = '';
  if (r.kind === 'video') {
    body = `<video class="ex-video" controls playsinline preload="metadata" ${r.cover ? `poster="${escAttr(r.cover)}"` : ''} src="${escAttr(r.play)}"></video>`;
  } else {
    const imgs = (r.images || []).slice(0, 30);
    body = `<div class="ex-imggrid">` + imgs.map((u, i) =>
      `<div class="iw"><img loading="lazy" src="${escAttr(u)}" alt=""><button class="dl" data-i="${i}" title="下载这张">↓</button></div>`
    ).join('') + `</div>`;
  }
  const cnt = r.kind === 'video' ? '视频' : ((r.images || []).length + ' 张图');
  return `
    <div class="ex-title">${title}</div>
    <div class="hint">${esc(plat ? plat.name : '')} · ${cnt}${r.fromCache ? ' · 命中自家缓存' : ''}</div>
    ${body}
    <div class="ex-actions">
      <button class="btn primary" id="ex-save">存入壁纸库</button>
      <button class="btn ghost" id="ex-dlall">${r.kind === 'video' ? '下载视频' : '下载全部'}</button>
      <button class="btn ghost" id="ex-open">打开原链接</button>
    </div>
    <div class="hint" id="ex-prog"></div>`;
}
let curExtract = null, curExtractURL = '';
function renderExtract(r, plat, url) {
  curExtract = r; curExtractURL = url;
  const box = $id('ex-result');
  box.classList.remove('hidden');
  box.innerHTML = exResultHTML(r, plat);

  box.querySelectorAll('.ex-imggrid .dl').forEach(b => {
    b.onclick = () => {
      const u = (r.images || [])[Number(b.dataset.i)];
      if (u) downloadSmart(u, (sanitizeName(r.title || 'img') + '-' + (Number(b.dataset.i) + 1) + guessExt(u)));
    };
  });
  $id('ex-dlall').onclick = () => downloadAll(r);
  $id('ex-open').onclick = () => window.open(url, '_blank', 'noopener');
  $id('ex-save').onclick = () => saveToLibrary(r, plat);
}
function guessExt(u) {
  const m = String(u).match(/\.(jpe?g|png|webp|gif|mp4|webm|m4v)(\?|#|$)/i);
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.jpg';
}

/* ---------- 下载全部（顺序执行，带进度） ---------- */
async function downloadAll(r) {
  const prog = $id('ex-prog');
  if (r.kind === 'video') {
    if (prog) prog.textContent = '下载中…';
    await downloadSmart(r.play, sanitizeName(r.title || 'video') + guessExt(r.play));
    if (prog) prog.textContent = '';
    return;
  }
  const imgs = r.images || [];
  for (let i = 0; i < imgs.length; i++) {
    if (prog) prog.textContent = '下载 ' + (i + 1) + ' / ' + imgs.length + ' …';
    try { await downloadViaBlob(imgs[i], sanitizeName(r.title || 'img') + '-' + (i + 1) + guessExt(imgs[i])); }
    catch (e) { /* 单张失败继续 */ }
    await sleep(250);
  }
  if (prog) prog.textContent = imgs.length ? '已全部尝试下载' : '';
}

/* ---------- 存入壁纸库（客户端取回 → 仓库直连提交） ---------- */
async function saveToLibrary(r, plat) {
  if (typeof WPGH === 'undefined' || !WPGH.cfg || !WPGH.cfg.pat) {
    toast('仓库连接不可用', 'warn'); return;
  }
  const btn = $id('ex-save');
  const prog = $id('ex-prog');
  const old = btn.textContent;
  btn.disabled = true;
  const set = (t) => { btn.textContent = t; if (prog) prog.textContent = t; };
  try {
    const list = r.kind === 'video' ? [r.play] : (r.images || []).slice(0, 30);
    if (!list.length) throw new Error('没有可保存的内容');
    const entries = [];
    for (let i = 0; i < list.length; i++) {
      set('取回 ' + (i + 1) + ' / ' + list.length + ' …');
      const u = list[i];
      let bytes = null;
      try {
        const resp = await withTimeout(fetch(u), 45000, '取回超时');
        if (resp && resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
      } catch (e) { /* 单张失败跳过 */ }
      if (!bytes || !bytes.length) continue;
      const ext = guessExt(u);
      const nm = sanitizeName((r.title || (plat ? plat.name : '解析')) + (list.length > 1 ? '-' + (i + 1) : '') + ext);
      entries.push({
        name: nm,
        bytes,
        size: bytes.byteLength,
        itemExtra: i === 0 ? { title: sanitizeName(r.title || (plat ? plat.name + ' 内容' : '解析结果')), cat: catOf(r.title || ''), kind: r.kind === 'video' ? 'video' : 'image', gif: false } : undefined,
      });
    }
    if (!entries.length) throw new Error('图片跨域取回失败（平台 CDN 拒绝），可逐张点「↓」下载后手动上传');
    set('提交中…');
    const committed = await WPGH.importEntries(entries, {
      onStatus: (idx, text) => set('提交 ' + (idx + 1) + '/' + entries.length),
    });
    try { committed.forEach(it => allItems.unshift(it)); renderAll(); } catch (e) {}
    toast('已存入壁纸库（' + committed.length + ' 个文件）', 'ok');
    set('已入库 ✓');
    setTimeout(() => { btn.disabled = false; btn.textContent = old; if (prog) prog.textContent = ''; }, 2500);
  } catch (e) {
    toast('入库失败：' + (e.message || e), 'bad');
    btn.disabled = false; btn.textContent = old;
    if (prog) prog.textContent = '';
  }
}

/* ---------- 失败提示（不再引导去任何第三方工具） ---------- */
function showFailHelp(url, msg) {
  const box = $id('ex-result');
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="ex-actions">
       <button class="btn" id="fail-open">↗ 打开原链接试试</button>
       <button class="btn ghost" id="fail-copy">🔗 复制链接</button>
       <button class="btn ghost" id="fail-retry">♻️ 再试一次</button>
     </div>
     <p class="hint">${esc(msg || '自家中转没抓到内容。可以打开原链接手动保存，或稍后再试一次。')}</p>`;
  $id('fail-open').onclick = () => window.open(url, '_blank', 'noopener');
  $id('fail-copy').onclick = () => copyText(url);
  $id('fail-retry').onclick = () => startExtract();
}
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => toast('复制失败', 'warn'));
}

/* ---------- 主入口 ---------- */
let exBusy = false;
async function startExtract() {
  if (exBusy) return;
  const inp = $id('ex-link');
  const raw = (inp && inp.value || '').trim();
  if (!raw) { toast('先粘贴一条分享链接', 'warn'); if (inp) inp.focus(); return; }

  /* 音乐链接 → 交给音乐模块（卡片 + 播放 + 下载都在音乐区） */
  if (typeof Music !== 'undefined' && Music.detect && Music.detect(raw)) {
    const mi = $id('mu-link');
    if (mi) mi.value = raw;
    Music.runInto(raw, 'mu-result');
    const card = $('section .card:nth-of-type(2)') || null;
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('这是音乐链接，已送到音乐解析区', 'ok');
    return;
  }

  const url = extractURL(raw);
  if (!url) { toast('没找到链接', 'warn'); if (inp) inp.focus(); return; }
  const plat = detectPlatform(url);
  if (!plat) {
    exStatus('暂不支持这个平台：目前支持 抖音 / 快手 / B站 / 小红书（音乐支持 网易云 / 汽水）', 'bad');
    showFailHelp(url, '粘贴 抖音 / 快手 / B站 / 小红书 的分享链接即可解析。');
    return;
  }

  exBusy = true;
  const box = $id('ex-result');
  try {
    /* L1 memo */
    const memo = memoGet(url);
    if (memo) {
      exStatus('本机缓存命中，秒出', 'ok');
      renderExtract(memo, plat, url);
      return;
    }
    /* L2 仓库缓存 */
    const key = parseCacheKey(url);
    exStatus('查自家缓存…', '');
    let e = await serverCacheGet(key);
    const good = e && !e.err && ((e.kind === 'images' && e.images && e.images.length) || (e.kind === 'video' && e.play));
    if (good) {
      memoPut(url, e);
      exStatus('命中自家解析缓存', 'ok');
      renderExtract(Object.assign({ fromCache: true }, e), plat, url);
      return;
    }
    if (e && e.err) exStatus('这条此前没抓到过，重新派单再试…', '');
    /* L3 自家中转 */
    const since = Date.now();
    exStatus('📮 寄给自家仓库代抓中（GitHub Actions）…', '');
    await relayDispatch(url, key);
    exStatus('📮 已寄出，仓库正在抓…', '');
    const got = await relayPoll(key, since, (i, sec) => exStatus('📮 仓库抓取中… ' + i + ' 轮（' + sec + 's）', ''));
    if (!got) throw new Error('代抓超时（约 90 秒没等到结果）。链接已入队，稍后再点一次解析即可');
    if (got.err) throw new Error('自家中转：' + got.err);
    memoPut(url, got);
    exStatus('✅ 自家仓库代抓完成', 'ok');
    renderExtract(got, plat, url);
  } catch (e) {
    exStatus('解析失败：' + (e.message || e), 'bad');
    showFailHelp(url, (e.message || String(e)));
  } finally {
    exBusy = false;
  }
}

/* ---------- 初始化 ---------- */
function initExtractor() {
  const inp = $id('ex-link');
  if (!inp) return;
  const paste = $id('ex-paste');
  if (paste) paste.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) { inp.value = t.trim(); startExtract(); return; }
    } catch (e) { /* 读不到就聚焦手粘 */ }
    inp.focus();
  });
  const go = $id('ex-go');
  if (go) go.addEventListener('click', () => startExtract());
  const clear = $id('ex-clear');
  if (clear) clear.addEventListener('click', () => {
    inp.value = ''; exStatus('', ''); const b = $id('ex-result'); if (b) { b.classList.add('hidden'); b.innerHTML = ''; }
    inp.focus();
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') startExtract(); });
  inp.addEventListener('paste', () => setTimeout(() => {
    /* 粘贴后自动开解析（有链接才动） */
    if (extractURL(inp.value)) startExtract();
  }, 120));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initExtractor);
else initExtractor();
