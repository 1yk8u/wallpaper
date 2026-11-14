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
  douyin:     { name: '抖音',   test: /douyin\.com|iesdouyin\.com|douyinapp/i },
  kuaishou:   { name: '快手',   test: /kuaishou\.com|chenzhongtech|gifshow\.com|kuaishouapp/i },
  bilibili:   { name: '哔哩哔哩', test: /bilibili\.com|b23\.tv|bilibili\.tv/i },
  xiaohongshu:{ name: '小红书', test: /xiaohongshu\.com|xhslink\.com|xhscdn/i },
};
function detectPlatform(u) {
  const s = String(u || '').toLowerCase();
  for (const k in PLATFORMS) {
    const p = PLATFORMS[k];
    if (p.test.test(s)) return Object.assign({ key: k }, p);
  }
  return null;
}

/* ---------- 缓存键：必须与 scripts/parse-queue.mjs 逐字节一致 ---------- */
function parseCacheKey(u) {
  /* 与后端 cacheKey 同构：先净化链接，避免整段口令 / 编码尾巴污染缓存键 */
  let s = String(u || '').trim();
  try { if (typeof extractURL === 'function') s = extractURL(s) || s; } catch (e) {}
  const raw = s.toLowerCase();
  const ne = raw.match(/(?:music\.)?163\.com\/[^\s]*[?&]id=(\d{4,14})/);
  if (ne) return 'netease:' + ne[1];
  /* 汽水两种分享形态：track_id=（数字）与 /s/<短码>（键统一小写） */
  if (/qishui|music\.douyin\.com/.test(raw)) {
    const tr = raw.match(/track_id=(\d{10,20})/);
    if (tr) return 'qishui:' + tr[1];
    const qs = raw.match(/qishui\.douyin\.com\/(?:song|s)\/([a-z0-9]{6,20})/);
    if (qs) return 'qishui:' + qs[1];
  }
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

/* ---------- L2 自家仓库缓存（三通道竞速 + 会话内复用） ----------
 * 旧实现串行先打 api.github.com：手机上常 30s+，匿名接口还会 403 限流，
 * 而超时只有 8 秒 —— 结果就是每次解析都永久卡在「查自家缓存…」。
 * 现在三路同时发，谁先成就用谁；600KB 的缓存一次会话只下一次。
 *   ① 同源 Pages：无跨域、无鉴权，最快（可能比仓库晚 1~2 分钟）
 *   ② raw.githubusercontent：实时 CDN
 *   ③ api.github.com + PAT：最实时、最慢，兜底
 * ------------------------------------------------------------------ */
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_SESSION_KEY = 'wp_parse_cache_v1';
let CACHE_BUF = null, CACHE_AT = 0, CACHE_INFLIGHT = null;

function ghCfg() {
  return (typeof WPGH !== 'undefined' && WPGH.cfg) ? WPGH.cfg : null;
}
function cacheFromSession() {
  try {
    const o = JSON.parse(sessionStorage.getItem(CACHE_SESSION_KEY) || 'null');
    if (o && o.at && Date.now() - o.at < CACHE_TTL && o.entries) return o.entries;
  } catch (e) {}
  return null;
}
function cacheToSession(entries) {
  try { sessionStorage.setItem(CACHE_SESSION_KEY, JSON.stringify({ at: Date.now(), entries: entries })); }
  catch (e) { /* 隐私模式 / 配额满：只留内存 */ }
}
async function fetchCacheJSON(url, init, ms) {
  const r = await withTimeout(fetch(url, init), ms, '缓存读取超时');
  if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : 0));
  return await r.json();
}
/* 多通道竞速：第一个成功即返回，后续成功仍会刷新内存里较新的那份 */
async function raceCache(chans) {
  return new Promise(resolve => {
    let left = chans.length, done = false;
    chans.forEach(run => run().then(j => {
      if (!j || !j.entries) return;
      if (!CACHE_BUF || String(j.updated || '') >= String(CACHE_BUF.updated || '')) {
        CACHE_BUF = j; CACHE_AT = Date.now(); cacheToSession(j.entries);
      }
      if (!done) { done = true; resolve(CACHE_BUF.entries); }
    }).catch(() => {}).finally(() => { if (--left === 0 && !done) resolve(null); }));
  });
}
async function loadCache(force, ms) {
  if (!force && CACHE_BUF && CACHE_AT && Date.now() - CACHE_AT < CACHE_TTL) return CACHE_BUF.entries;
  if (!force) {
    const s = cacheFromSession();
    if (s) { CACHE_BUF = { entries: s }; CACHE_AT = Date.now(); return s; }
  }
  if (CACHE_INFLIGHT && !force) return CACHE_INFLIGHT;
  const cfg = ghCfg(), bust = Date.now();
  const chans = [
    () => fetchCacheJSON('data/parse-cache.json?t=' + bust, { cache: 'no-store' }, ms),
  ];
  if (cfg) chans.push(() => fetchCacheJSON(
    'https://raw.githubusercontent.com/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
    '/' + encodeURIComponent(cfg.branch) + '/data/parse-cache.json?t=' + bust, { cache: 'no-store' }, ms));
  if (cfg && cfg.pat) chans.push(() => fetchCacheJSON(
    'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
    '/contents/data/parse-cache.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + bust,
    { cache: 'no-store', headers: { 'Accept': 'application/vnd.github.raw', 'Authorization': 'Bearer ' + cfg.pat } }, ms));

  const job = raceCache(chans);
  CACHE_INFLIGHT = job.finally(() => { CACHE_INFLIGHT = null; });
  return CACHE_INFLIGHT;
}
async function serverCacheGet(key, opt) {
  opt = opt || {};
  /* 20 秒下限：手机网络慢也不能像旧版那样 8 秒就判死 */
  const entries = await loadCache(false, Math.max(opt.ms || 0, 20000));
  return (entries && entries[key]) || null;
}

/* ---------- L3 轻量单条结果（data/parsed/<hash>.json，<2KB） ----------
 * 中转每抓完一条就单独写一个小文件，轮询只读它，不再反复下 600KB 总缓存。
 * 文件名与 scripts/parse-queue.mjs 的 sha256(key).slice(0,16) 逐字节一致。
 * ------------------------------------------------------------------ */
async function parsedPath(key) {
  const h = await sha256Hex(key);
  return 'data/parsed/' + h.slice(0, 16) + '.json';
}
const tsOf = (j) => Date.parse((j && j.ts) || '') || 0;
async function lightResultGet(key, ms, since) {
  const cfg = ghCfg();
  const p = await parsedPath(key), bust = Date.now();
  ms = ms || 12000;
  const chans = [];
  /* api.github.com 是唯一实时的通道（~1s）；raw CDN 有几分钟旧缓存，
   * 同源 Pages 更慢更滞后 —— 不能「谁先返回用谁」，否则旧结果会盖掉新的。 */
  if (cfg && cfg.pat) chans.push({ rt: true, run: () => fetchCacheJSON(
    'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
    '/contents/' + p + '?ref=' + encodeURIComponent(cfg.branch) + '&t=' + bust,
    { cache: 'no-store', headers: { 'Accept': 'application/vnd.github.raw', 'Authorization': 'Bearer ' + cfg.pat } }, ms) });
  if (cfg) chans.push({ rt: false, run: () => fetchCacheJSON(
    'https://raw.githubusercontent.com/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
    '/' + encodeURIComponent(cfg.branch) + '/' + p + '?t=' + bust, { cache: 'no-store' }, ms) });
  chans.push({ rt: false, run: () => fetchCacheJSON(p + '?t=' + bust, { cache: 'no-store' }, ms) });

  return new Promise(resolve => {
    let done = false, best = null, settled = 0;
    const finish = () => { if (!done) { done = true; resolve(best); } };
    chans.forEach(c => c.run().then(j => {
      if (j && typeof j === 'object' && (!best || tsOf(j) > tsOf(best))) best = j;
      /* 拿到本次写入的结果就立刻交卷 */
      if (!done && since && j && tsOf(j) >= since - 15000) { done = true; resolve(j); return; }
      /* 实时通道回话后只再等 1 秒给快的备胎，绝不陪 Pages 耗 */
      if (c.rt) setTimeout(finish, 1000);
    }).catch(() => { if (c.rt) setTimeout(finish, 1000); })
      .finally(() => { if (++settled === chans.length) finish(); }));
    setTimeout(finish, 8000);   /* 绝对兜底，保证每轮不会挂死 */
  });
}

/* ---------- L3 自家中转：寄单 + 轮询 ---------- */
async function relayDispatch(url, key) {
  const cfg = WPGH.cfg;
  let r;
  try {
    r = await withTimeout(fetch(
      'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/dispatches', {
        method: 'POST',
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + cfg.pat },
        body: JSON.stringify({ event_type: 'parse-request', client_payload: { url: url, key: key } }),
      }), 30000, '派单超时');
  } catch (e) {
    /* 手机网络抖动时响应慢，但 GitHub 往往已经收到派单并跑起了 Actions。
     * 这类「软失败」不能当失败处理，继续轮询照样能拿到结果。 */
    const soft = new Error('派单响应慢（可能已寄出，继续等仓库结果）');
    soft.soft = true;
    throw soft;
  }
  if (r.status !== 204) throw new Error('派单失败 HTTP ' + r.status + '（令牌可能已失效）');
}
async function relayPoll(key, since, onTick) {
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {           /* 每轮约 5 秒，上限约 2 分钟 */
    await sleep(3000);
    let e = await lightResultGet(key, 12000, since);  /* 只读单条小文件，按 ts 取最新 */
    if (!e && i % 5 === 4) {              /* 三通道全不通时，偶尔刷一次总缓存兜底 */
      const entries = await loadCache(true, 15000);
      e = (entries && entries[key]) || null;
    }
    if (e) {
      const ts = Date.parse(e.ts || '') || 0;
      if (ts >= since - 15000) return e; /* 是这次（或刚覆盖）写入的结果 */
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
  /* 自家仓库里的文件名常带 # / ? / 中文，直接塞进 src 会被当成锚点/查询截断 → 全 404。
   * mediaOf()（app.js）做 encodeURI + %23/%3F 转义，绝对 URL 原样返回。 */
  const mu = (u) => (typeof mediaOf === 'function') ? mediaOf(u) : String(u || '');
  let body = '';
  if (r.kind === 'video') {
    body = `<video class="ex-video" controls playsinline preload="metadata" ${r.cover ? `poster="${escAttr(mu(r.cover))}"` : ''} src="${escAttr(mu(r.play))}"></video>`;
  } else {
    const imgs = (r.images || []).slice(0, 30);
    body = `<div class="ex-imggrid">` + imgs.map((u, i) =>
      `<div class="iw"><img loading="lazy" src="${escAttr(mu(u))}" alt=""><button class="dl" data-i="${i}" title="下载这张">↓</button></div>`
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
      if (u) downloadSmart((typeof mediaOf === 'function') ? mediaOf(u) : u,
        (sanitizeName(r.title || 'img') + '-' + (Number(b.dataset.i) + 1) + guessExt(u)));
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
  const mu = (u) => (typeof mediaOf === 'function') ? mediaOf(u) : u;
  if (r.kind === 'video') {
    if (prog) prog.textContent = '下载中…';
    await downloadSmart(mu(r.play), sanitizeName(r.title || 'video') + guessExt(r.play));
    if (prog) prog.textContent = '';
    return;
  }
  const imgs = r.images || [];
  for (let i = 0; i < imgs.length; i++) {
    if (prog) prog.textContent = '下载 ' + (i + 1) + ' / ' + imgs.length + ' …';
    try { await downloadViaBlob(mu(imgs[i]), sanitizeName(r.title || 'img') + '-' + (i + 1) + guessExt(imgs[i])); }
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
        const fetchURL = (typeof mediaOf === 'function') ? mediaOf(u) : u;
        const resp = await withTimeout(fetch(fetchURL), 45000, '取回超时');
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
    const cards = $id('tab-extract') ? $id('tab-extract').querySelectorAll('.ex-card') : [];
    if (cards[1]) cards[1].scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    /* L2 仓库缓存（三通道竞速，手机也不卡） */
    const key = parseCacheKey(url);
    exStatus('查自家缓存（多路并发）…', '');
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
    try {
      await relayDispatch(url, key);
      exStatus('📮 已寄出，仓库正在抓…', '');
    } catch (e) {
      if (!e.soft) throw e;   /* 软超时：继续轮询，GitHub 多半已在抓 */
      exStatus('📮 派单响应慢，仓库可能已在抓，继续等结果…', '');
    }
    const got = await relayPoll(key, since, (i, sec) => exStatus('📮 仓库抓取中… ' + i + ' 轮（' + sec + 's），页面别关', ''));
    if (!got) throw new Error('代抓约 2 分钟还没出结果（平台可能风控或仓库排队）。链接已入队，稍后再点一次「开始解析」通常就命中缓存');
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
    /* 手机浏览器（iOS Safari / 微信内置）常禁止 JS 读剪贴板，读不到就给明确指引 */
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch (e) {}
    if (t && t.trim()) { inp.value = t.trim(); startExtract(); return; }
    inp.focus();
    toast('浏览器不让自动读剪贴板：请长按输入框手动粘贴，粘贴后会自动开始解析', 'warn');
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
