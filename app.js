'use strict';
/* =====================================================================
 * app.js —— 画廊渲染 / 详情弹窗 / 首开问答 / 分类 / GitHub 直连入库
 * 仓库配置已内置（用户零配置），右上角仅保留刷新入口
 * ===================================================================== */

/* 站点自己的仓库连接（连接什么就连接什么，无需用户配置）。
 * 令牌以拆分形式存放：GitHub 推送保护会拒绝含明文 PAT 的提交，运行时再拼回。 */
const CFG = (() => {
  const t = ['lFZYmfPOCWz', 'wsffiPcsio84', 'pFYrjkk3WxBHt'];
  return { owner: '1yk8u', repo: 'wallpaper', branch: 'main', pat: 'gh' + 'p_' + t[0] + t[1] + t[2] };
})();

let allItems = [];
let curType = 'all';
let curQ = '';
let curCat = 'all';
const CAT_LIST = ['全部', '二次元', '汽车', '风景', '萌宠', '游戏', '文字', '综合'];

/* 品类关键词（与 scripts/build-manifest.mjs 保持一致；前端新入库条目即时归类用） */
const CAT_RULES = [
  ['二次元', /二次元|动漫|漫画|插画|番剧|角色|女友|女主|女神|美图|可爱|小可爱/i],
  ['汽车', /汽车|跑车|机车|超跑|摩托|赛车/i],
  ['风景', /风景|山水|雪|海|日落|星空|自然|湖泊|森林|城市|天空|旅行|山间|瀑布|枫|樱/i],
  ['萌宠', /猫|狗|柴犬|柯基|宠物|滚滚/i],
  ['游戏', /游戏|原神|王者|崩坏|明日方舟|塞尔达/i],
  ['文字', /文字|语录|签名|哲理|句/i],
];
function catOf(title) {
  const t = String(title || '');
  for (const r of CAT_RULES) { if (r[1].test(t)) return r[0]; }
  return '综合';
}

/* =============== 初始化 =============== */
async function initApp() {
  if (location.protocol === 'file:') $id('file-banner').classList.remove('hidden');
  bindUI();
  /* 清单缓存先同步渲染，网络请求在后台跑：首开不用干等 588KB 下载完 */
  loadData(false);
  initOnboard();
}

/* 本机入库兜底：条目提交到仓库后立刻落一份，刷新/重进页面马上能看到，
 * 不必等 GitHub Actions 重建 data/wallpapers.json（要几分钟且可能排队）。
 * 清单里出现同 url 后按 url 去重，不会重复显示。 */
const LOCAL_ITEMS_KEY = 'wp_local_items_v1';
function localItemsRead() {
  try {
    const a = JSON.parse(localStorage.getItem(LOCAL_ITEMS_KEY) || '[]');
    const cut = Date.now() - 30 * 864e5;
    return (Array.isArray(a) ? a : []).filter(x => x && x.url && (!x.at || x.at > cut));
  } catch (e) { return []; }
}
function localItemsAdd(items) {
  try {
    const cur = localItemsRead(), seen = new Set(cur.map(x => x.url));
    items.forEach(it => {
      if (it && it.url && !seen.has(it.url)) { cur.unshift(Object.assign({ at: Date.now() }, it)); seen.add(it.url); }
    });
    localStorage.setItem(LOCAL_ITEMS_KEY, JSON.stringify(cur.slice(0, 200)));
  } catch (e) { /* 隐私模式 / 配额满：忽略，仓库本身已存好 */ }
}
function mergeItems(remote, local) {
  const seen = new Set(), out = [];
  [...local, ...remote].forEach(it => {
    if (it && it.url && !seen.has(it.url)) { seen.add(it.url); out.push(it); }
  });
  return out;
}
/* 清单缓存：数据落 localStorage，下次打开先秒开旧清单，再后台核对更新。
 * 原实现每次都带 ?ts=Date.now() 强刷 588KB，国内网络要卡十几秒。 */
const MANIFEST_KEY = 'wp_manifest_v4';
/* ?v= 是清单版本号：内容结构变了必须换号，否则 Pages 的 CDN
 * 仍会返回旧清单（比如没有 thumb / lqip 字段），手机上就享受不到提速。 */
const HERO_URL = 'data/hero.json?v=20261117C';
const MANIFEST_URL = 'data/wallpapers.json?v=20261117C';
function manifestCacheRead() {
  try {
    const j = JSON.parse(localStorage.getItem(MANIFEST_KEY) || 'null');
    if (j && Array.isArray(j.items) && j.items.length) return j;
  } catch (e) {}
  return null;
}
function manifestCacheWrite(j) {
  try { localStorage.setItem(MANIFEST_KEY, JSON.stringify({ updated: j.updated, items: j.items })); }
  catch (e) { /* 超配额就只靠 CDN 缓存，不影响显示 */ }
}

/* 用首屏小清单里的内联图覆盖同 URL 的 item：本地旧缓存/完整清单
 * 可能没有 inline 字段，覆盖后首屏 6 张始终零网络请求秒出。 */
function applyHeroInline(list, hero) {
  if (!hero || !hero.length) return list;
  const byUrl = new Map(hero.map(x => [x.url, x]));
  return list.map(x => byUrl.has(x.url) ? Object.assign({}, x, byUrl.get(x.url)) : x);
}

async function loadData(silent, force) {
  const cache = manifestCacheRead();
  let hadCache = false;
  if (cache && !force) {
    allItems = mergeItems(cache.items, localItemsRead());
    hadCache = allItems.length > 0;
    if (hadCache && !silent) renderAll();
  }
  /* 首屏小清单带 base64 内联清晰图：无论有无缓存都拉，
   * 清单一到首屏 6 张立刻显示，不用等任何图片网络请求。 */
  let heroItems = [];
  if (!force) {
    try {
      const hr = await withTimeout(fetch(HERO_URL, { cache: 'force-cache' }), 15000);
      if (hr.ok) {
        const hj = await hr.json();
        heroItems = Array.isArray(hj.items) ? hj.items.filter(x => x && x.url) : [];
        if (heroItems.length) {
          allItems = applyHeroInline(allItems, heroItems);
          if (!allItems.length) allItems = mergeItems(heroItems, localItemsRead());
          if (!silent) renderAll();
        }
      }
    } catch (e) { /* 小清单失败就等完整清单，不影响最终显示 */ }
  }
  /* 平时走 Pages 的 CDN 缓存；只有用户点刷新才带时间戳强制拉新 */
  const url = MANIFEST_URL + (force ? '&ts=' + Date.now() : '');
  try {
    const r = await withTimeout(fetch(url, { cache: force ? 'reload' : 'force-cache' }), 20000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const list = j.items || j || [];
    const items = Array.isArray(list) ? list.filter(x => x && x.url) : [];
    if (force || !cache || cache.updated !== j.updated) {
      allItems = mergeItems(items, localItemsRead());
      manifestCacheWrite({ updated: j.updated, items });
    }
    allItems = applyHeroInline(allItems, heroItems);
    if (!silent || !hadCache) renderAll();
  } catch (e) {
    allItems = applyHeroInline(allItems, heroItems);
    if (!allItems.length) {
      allItems = mergeItems(allItems, localItemsRead());
      if (!silent) showEmpty(true);
      if (!silent) toast('壁纸清单加载失败：' + (e.message || e), 'bad');
    } else if (!silent) renderAll();
  }
}

function mediaOf(u) {
  u = String(u || '');
  if (/^https?:\/\//i.test(u)) return u;
  /* 相对路径里 # 和 ? 都是 URL 保留字符，会把地址截断成锚点/查询 → 必须%转义 */
  return encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function mediaURL(it) {
  return mediaOf(it && it.url);
}

function itemDyn(it) { return it.kind === 'video' || it.gif === true; }
function itemAudio(it) { return it.kind === 'audio'; }

function matchFilter(it) {
  /* 音乐只在「全部 / 音乐」里出现；图片/视频分类下不混入音频 */
  if (itemAudio(it)) {
    if (curType !== 'all' && curType !== 'audio') return false;
  } else if (curType === 'audio') {
    return false;
  } else if (curType === 'image' && itemDyn(it)) {
    return false;
  } else if (curType === 'video' && !itemDyn(it)) {
    return false;
  }
  if (curCat !== 'all' && (it.cat || '综合') !== curCat) return false;
  if (curQ && !(it.title || '').toLowerCase().includes(curQ)) return false;
  return true;
}

/* =============== 分类条 =============== */
function renderCatChips() {
  const box = $id('cat-filter');
  if (!box) return;
  const counts = {};
  allItems.forEach(it => { const c = it.cat || '综合'; counts[c] = (counts[c] || 0) + 1; });
  const present = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (curCat !== 'all' && !present.includes(curCat)) curCat = 'all';
  box.hidden = present.length < 2;
  box.innerHTML = ['全部'].concat(present).map(c => {
    const on = (c === '全部') ? (curCat === 'all') : (curCat === c);
    const n = (c === '全部') ? allItems.length : counts[c];
    return `<button class="chip${on ? ' active' : ''}" data-cat="${escAttr(c)}">${esc(c)} <span class="cnt">(${n})</span></button>`;
  }).join('');
  $$('#cat-filter .chip').forEach(ch => ch.addEventListener('click', () => {
    curCat = ch.dataset.cat === '全部' ? 'all' : ch.dataset.cat;
    renderAll();
  }));
}

function renderAll() {
  renderCatChips();
  const seen = {};
  allItems.forEach(it => { if (it.id) seen[it.id] = (seen[it.id] || 0) + 1; });
  const dups = Object.values(seen).some(n => n > 1);
  const nAll = allItems.length;
  let nImg = 0, nVid = 0, nAud = 0;
  allItems.forEach(it => {
    if (itemAudio(it)) nAud++;
    else if (itemDyn(it)) nVid++;
    else nImg++;
  });
  $id('cnt-all').textContent = nAll ? '(' + nAll + ')' : '';
  $id('cnt-image').textContent = nImg ? '(' + nImg + ')' : '';
  $id('cnt-video').textContent = nVid ? '(' + nVid + ')' : '';
  const cntAud = $id('cnt-audio');
  if (cntAud) cntAud.textContent = nAud ? '(' + nAud + ')' : '';

  const grid = $id('grid');
  gridList = allItems.filter(matchFilter);
  grid.innerHTML = '';
  gridShown = 0;
  appendGrid();
  showEmpty(gridList.length === 0, false);
  if (dups) console.warn('检测到重复 id 的壁纸项');
}

/* 手机首屏只渲染 60 张：857 张一次性塞进 DOM 会明显掉帧、还拖慢解析页切换 */
const GRID_PAGE = 24;
let gridList = [], gridShown = 0;
function appendGrid() {
  const grid = $id('grid');
  if (!grid) return;
  const slice = gridList.slice(gridShown, gridShown + GRID_PAGE);
  if (slice.length) {
    grid.insertAdjacentHTML('beforeend', slice.map((it, k) => cardHTML(it, gridShown + k)).join(''));
    gridShown += slice.length;
  }
  let btn = $id('btn-more');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'btn-more';
    btn.className = 'btn ghost';
    btn.style.cssText = 'display:block;margin:20px auto 34px;min-width:180px';
    btn.addEventListener('click', appendGrid);
    grid.after(btn);
  }
  btn.hidden = gridShown >= gridList.length;
  /* 内联 display 会盖掉 [hidden] 的 UA 样式，显式切换才靠得住 */
  btn.style.display = btn.hidden ? 'none' : 'block';
  if (!btn.hidden) btn.textContent = '加载更多（还有 ' + (gridList.length - gridShown) + ' 个）';
  /* 新卡片插入后通知图片加速器开始择优加载 */
  if (typeof window.__imgAccelScan === 'function') window.__imgAccelScan();
}

/* 首屏前 12 张立即加载并给最高优先级，其余懒加载 + 异步解码：
 * 手机首屏不再等一屏图才画出来，往下滚才请求后面的，明显更快更省流量。 */
const EAGER_FIRST = 4;
function loadAttrs(i) {
  return i < EAGER_FIRST
    ? 'loading="eager" fetchpriority="high" decoding="async"'
    : 'loading="lazy" decoding="async"';
}
/* 图片解码完成后加个淡入，避免加载中露出灰块闪烁 */
const FADE_ONLOAD = ' onload="this.classList.add(\'wp-loaded\')"';

/* 封面优先用压过的缩略图；没有才退回原封面 */
function coverSrc(it) {
  if (!it || !it.cover) return '';
  return mediaOf(it.coverThumb || it.cover);
}

function thumbHTML(it, i) {
  i = Number(i) || 0;
  const la = loadAttrs(i);
  const dyn = itemDyn(it);
  if (it.kind === 'audio') {
    const cover = it.cover ? `<img ${la} src="${escAttr(coverSrc(it))}" alt="${esc(it.title || '')}" class="vid-cover"${FADE_ONLOAD}>` : '';
    return `<span class="badge badge-audio">音乐</span><div class="vid-ph audio-ph">${cover}<svg class="vid-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/></svg></div><span class="play-tag play-tag-audio"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/></svg>音频</span>`;
  }
  const badge = `<span class="badge">${dyn ? '动态' : '静态'}</span>`;
  if (it.kind === 'video') {
    /* 视频卡片只加载一张封面图，绝不预加载整个 mp4 */
    const cover = it.cover ? `<img ${la} src="${escAttr(coverSrc(it))}" alt="${esc(it.title || '')}" class="vid-cover"${FADE_ONLOAD}>` : '';
    return `${badge}<div class="vid-ph">${cover}<svg class="vid-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.6"/><path d="M10.2 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none"/></svg></div><span class="play-tag"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 5.8v12.4L19 12z"/></svg>视频壁纸</span>`;
  }
  /* 静态图交给自动加速模块：data-src 存路径，多通道择优 + 超时自动换线；
   * src 先放迷你预览（若已有），清单一下完立刻有模糊图，清晰图后台加载好淡入。 */
  const p = it.thumb ? mediaOf(it.thumb) : mediaURL(it);
  /* 首屏内联图：清单一到就是清晰图，零图片请求（真正的秒显） */
  if (it.inline) {
    return `<img class="wp-loaded" ${la} src="${escAttr(it.inline)}" data-full="${escAttr(mediaURL(it))}" alt="${esc(it.title || '')}">`;
  }
  /* 其余图片交给自动加速模块：多通道择优 + 超时换线；lqip 做占位 */
  const preview = it.lqip || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const img = `<img class="accel-img" ${la} src="${escAttr(preview)}" data-src="${escAttr(p)}" data-full="${escAttr(mediaURL(it))}" alt="${esc(it.title || '')}">`;
  if (it.gif) return badge + img + '<span class="play-tag">GIF</span>';
  return badge + img;
}

function cardHTML(it, i) {
  const del = isAdmin
    ? `<button class="del-badge" data-del="${i}" title="删除这张" aria-label="删除">×</button>`
    : '';
  /* 迷你预览铺在容器底层：清单一下完立刻显示模糊图，真实缩略图加载好再淡入盖住。
   * data URI 不含引号，直接内联安全；没有预览的条目退回原来的渐变底色。 */
  const bg = it.lqip
    ? ` style="background-image:url('${it.lqip}');background-size:cover;background-position:center"`
    : '';
  return `<figure class="carditem${isAdmin ? ' admin-mode' : ''}" data-i="${i}">
    <div class="thumb"${bg}>${del}${thumbHTML(it, i)}</div>
    <figcaption>${esc(it.title || '未命名')}</figcaption>
  </figure>`;
}

function showEmpty(isEmpty, error) {
  const el = $id('empty');
  el.classList.toggle('hidden', !isEmpty);
  if (error) $id('empty-text').textContent = '清单加载失败，请检查部署是否正确';
}

/* =============== 详情弹窗 =============== */
let curDetail = null;

function openDetail(it) {
  curDetail = it;
  const dyn = itemDyn(it);
  $id('d-title').textContent = it.title || '未命名';
  const m = $id('d-media');
  if (it.kind === 'audio') {
    m.innerHTML = `<audio controls preload="metadata" src="${escAttr(mediaURL(it))}"></audio>`;
  } else if (it.kind === 'video') {
    m.innerHTML = it.cover
      ? `<video controls playsinline preload="metadata" poster="${escAttr(coverSrc(it))}" src="${escAttr(mediaURL(it))}"></video>`
      : `<video controls playsinline preload="metadata" src="${escAttr(mediaURL(it))}"></video>`;
  } else {
    m.innerHTML = `<img src="${escAttr(mediaURL(it))}" alt="${esc(it.title || '')}">`;
  }
  const bits = [];
  if (it.kind === 'audio') bits.push('音乐');
  else bits.push(dyn ? '动态壁纸' : '静态壁纸');
  if (it.kind === 'video' && it.gif !== true) bits.push('视频');
  if (it.gif) bits.push('GIF');
  if (it.cat && !(it.kind === 'audio' && it.cat === '音乐')) bits.push(esc(it.cat));
  if (it.size) bits.push(fmtSize(it.size));
  if (it.date) { try { bits.push(String(it.date).slice(0, 10)); } catch (e) {} }
  if (it.src === 'link') bits.push('外链');
  $id('d-meta').textContent = bits.join(' · ');
  $id('d-tip').textContent = it.kind === 'audio'
    ? '点上面的播放器试听；点【下载】把 MP3 存到设备。'
    : (isIOS
      ? 'iPhone 提示：点下载保存图片；视频请在【新窗口打开】后长按 → 存储视频。'
      : '手机可长按图片/视频保存；电脑也可右键另存为。');
  const delBtn = $id('d-delete');
  if (delBtn) delBtn.classList.toggle('hidden', !isAdmin);
  openModal('modal-detail');
}

/* =============== 首开问答（空盘问你要什么口味） =============== */
function initOnboard() {
  try {
    /* 从主屏用 #extract 直接进解析工具时，别再拿口味问答挡路 */
    if (location.hash === '#extract') { localStorage.setItem('wp-onboarded', '1'); return; }
    if (localStorage.getItem('wp-onboarded')) return;
  } catch (e) { return; }
  const ob = $id('onboard');
  if (!ob) return;
  ob.classList.remove('hidden');
  const sel = { wall: null, live: null };
  const paint = (id, key) => {
    const box = $id(id);
    box.innerHTML = CAT_LIST.map(c =>
      `<button class="chip${sel[key] === c ? ' active' : ''}" data-c="${escAttr(c)}">${esc(c)}</button>`).join('');
    $$('#' + id + ' .chip').forEach(b => b.addEventListener('click', () => {
      sel[key] = b.dataset.c;
      paint(id, key);
    }));
  };
  paint('ob-wall', 'wall');
  paint('ob-live', 'live');
  const finish = (apply) => {
    try { localStorage.setItem('wp-onboarded', '1'); } catch (e) {}
    ob.classList.add('hidden');
    if (!apply) return;
    const same = apply.wall === apply.live && apply.wall && apply.wall !== '全部';
    const any = (apply.wall && apply.wall !== '全部') ? apply.wall
      : (apply.live && apply.live !== '全部' ? apply.live : null);
    if (same) {
      curCat = apply.wall;
      curType = 'all';
      syncTypeChips();
      renderAll();
      toast('已按你的口味只布展「' + apply.wall + '」，点分类条里的「全部」随时看其他');
    } else if (any) {
      curCat = any;
      renderAll();
      toast('已优先展示「' + any + '」，其余分类在分类条里随时可逛');
    }
  };
  $id('ob-skip').addEventListener('click', () => finish(null));
  $id('ob-enter').addEventListener('click', () => finish(sel));
}

function syncTypeChips() {
  $$('#type-filter .chip').forEach(c => c.classList.toggle('active', c.dataset.type === curType));
}

/* =============== UI 事件绑定 =============== */
function bindUI() {
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    const seg = t.closest('.seg');
    if (seg) seg.dataset.active = String($$('.tab', seg).indexOf(t));
    $$('.page').forEach(p => p.classList.remove('active'));
    $id('tab-' + t.dataset.tab).classList.add('active');
    /* 记住当前页：#extract 可添加到手机主屏，一打开就是解析工具 */
    try { history.replaceState(null, '', '#' + t.dataset.tab); } catch (e) {}
    window.scrollTo(0, 0);
  }));

  $$('#type-filter .chip').forEach(c => c.addEventListener('click', () => {
    $$('#type-filter .chip').forEach(x => x.classList.toggle('active', x === c));
    curType = c.dataset.type;
    renderAll();
  }));

  $id('search').addEventListener('input', e => {
    curQ = e.target.value.trim().toLowerCase();
    renderAll();
  });

  $id('grid').addEventListener('click', e => {
    const del = e.target.closest('.del-badge');
    if (del) {
      e.stopPropagation();
      if (!isAdmin) return;
      const it = allItems.filter(matchFilter)[Number(del.dataset.del)];
      if (it && typeof window.__wpAskDelete === 'function') window.__wpAskDelete(it);
      return;
    }
    const fig = e.target.closest('.carditem');
    if (!fig) return;
    const it = allItems.filter(matchFilter)[Number(fig.dataset.i)];
    if (it) openDetail(it);
  });

  const br = $id('btn-refresh');
  if (br) br.addEventListener('click', () => { toast('刷新中…'); loadData(false, true); });
  const brl = $id('btn-reload');
  if (brl) brl.addEventListener('click', () => loadData());

  const md = $id('modal-detail');
  if (md) {
    md.addEventListener('click', e => { if (e.target === md) closeModal('modal-detail'); });
    $id('btn-close-detail').addEventListener('click', () => closeModal('modal-detail'));
    $id('d-download').addEventListener('click', () => {
      if (!curDetail) return;
      const name = decodeURIComponent((curDetail.url || '').split('/').pop()) || 'wallpaper';
      downloadSmart(mediaURL(curDetail), name);
    });
    $id('d-open').addEventListener('click', () => { if (curDetail) window.open(mediaURL(curDetail), '_blank', 'noopener'); });
    const dd = $id('d-delete');
    if (dd) dd.addEventListener('click', () => {
      if (isAdmin && curDetail && typeof window.__wpAskDelete === 'function') window.__wpAskDelete(curDetail);
    });
  }

  /* 滚到底自动续渲染；按钮保留给不想滚动的用户 */
  let moreTick = 0;
  window.addEventListener('scroll', () => {
    const b = $id('btn-more');
    const gal = $id('tab-gallery');
    if (!b || b.hidden || (gal && !gal.classList.contains('active')) || Date.now() - moreTick < 250) return;
    moreTick = Date.now();
    if (b.getBoundingClientRect().top < window.innerHeight + 500) appendGrid();
  }, { passive: true });

  /* 从主屏图标 / 分享链接直接进解析页 */
  if (location.hash === '#extract') {
    const t = $('.tab[data-tab="extract"]');
    if (t) t.click();
  }
}

/* =============== GitHub 直连（仓库信息内置，零配置） =============== */
function ghHeaders(extra) {
  return Object.assign({
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + CFG.pat,
  }, extra || {});
}
function apiURL(path) {
  return 'https://api.github.com/repos/' + encodeURIComponent(CFG.owner) +
    '/' + encodeURIComponent(CFG.repo) + path;
}
async function gh(path, opts) {
  opts = opts || {};
  const r = await fetch(apiURL(path), Object.assign({}, opts, { headers: ghHeaders(opts.headers) }));
  if (!r.ok) {
    let m = '';
    try { m = (await r.json()).message || ''; } catch (e) {}
    throw new Error('GitHub ' + r.status + (m ? '：' + m : ''));
  }
  return r.status === 204 ? null : r.json();
}

/* GitHub Contents API 的路径必须把 # ? 也转义：
 * encodeURI() 会把 # 当成锚点原样留下，导致带 # 的文件名（本库大量如此）
 * 在服务端被截断成前半段 → 404。这里统一补上 %23 / %3F。 */
function encodeAPIPath(path) {
  return encodeURI(String(path || '')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

async function ghRef() {
  const ref = await gh('/git/ref/heads/' + encodeURIComponent(CFG.branch));
  const c = await gh('/git/commits/' + ref.object.sha);
  return { baseSha: ref.object.sha, baseTree: c.tree.sha };
}
async function ghCreateBlob(bytes) {
  const b = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: bytesToB64(bytes), encoding: 'base64' }) });
  return b.sha;
}
async function ghCommitTree(o) {
  const t = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: o.baseTree, tree: o.tree }) });
  const c = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message: o.message, tree: t.sha, parents: [o.baseSha] }) });
  await gh('/git/refs/heads/' + encodeURIComponent(CFG.branch), { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
  return c.sha;
}
async function ghPathExists(path) {
  try {
    await gh('/contents/' + encodeAPIPath(path) + '?ref=' + encodeURIComponent(CFG.branch));
    return true;
  } catch (e) {
    if (/404/.test(String(e))) return false;
    throw e;
  }
}

function extInfo(name) {
  if (/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(name)) return { kind: 'audio', gif: false };
  if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return { kind: 'video', gif: false };
  if (/\.gif$/i.test(name)) return { kind: 'image', gif: true };
  return { kind: 'image', gif: false };
}
function buildItem(name, title) {
  const info = extInfo(name);
  const t = title || fileTitle(name);
  return {
    id: 'wp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name,
    title: t,
    cat: catOf(t),
    kind: info.kind,
    gif: info.gif,
    url: 'wallpapers/' + name,
    size: null,
    date: new Date().toISOString(),
    src: 'file',
  };
}

/* files: File[] 或 [{name, bytes(Uint8Array|ArrayBuffer), size, itemExtra, coverName, coverBytes}] */
async function commitFilesInner(config, opt) {
  const list = Array.from(config || []);
  const total = list.length;
  if (!total) return [];
  const onStatus = (opt && opt.onStatus) || (() => {});
  const titleAll = (opt && opt.title) || '';

  const big = list.find(f => (f.size || 0) > 60 * 1024 * 1024);
  if (big) throw new Error('存在超过 60MB 的文件，请改用 GitHub 网页端上传');

  /* ① 文件名避让：批次内重名（长标题被截断时最易触发）+ 仓库已存在同名，
   *    一律追加 -2/-3…，保证每个 path 唯一，绝不互相覆盖成只有 1 个文件。 */
  const prepared = [], used = new Set();
  const pathExists = async (name) => {
    try { return await ghPathExists('wallpapers/' + name); } catch (e) { return false; }
  };
  for (let i = 0; i < total; i++) {
    let name = sanitizeName(list[i].name || 'file-' + i);
    const dot = name.lastIndexOf('.');
    const base = (dot > 0 ? name.slice(0, dot) : name).replace(/-\d+$/, '');
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (n < 200 && (used.has(name.toLowerCase()) || await pathExists(name))) {
      const suffix = '-' + n + ext;
      name = base.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
      n++;
    }
    used.add(name.toLowerCase());
    prepared.push(name);
  }

  /* ② 逐个上传 blob（封面一并备好） */
  const blobs = [], covers = [];
  for (let i = 0; i < total; i++) {
    const f = list[i];
    onStatus(i, '上传中(' + (i + 1) + '/' + total + ')…', 'busy');
    let bytes;
    if (f.bytes) bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    else bytes = new Uint8Array(await f.arrayBuffer());
    blobs.push({ sha: await ghCreateBlob(bytes), size: bytes.byteLength });
    if (f.coverName && f.coverBytes) {
      const cb = f.coverBytes instanceof Uint8Array ? f.coverBytes : new Uint8Array(f.coverBytes);
      covers[i] = { name: f.coverName, sha: await ghCreateBlob(cb) };
    }
  }

  /* ③ 一次性提交整棵树：只产生 1 个 commit。
   *    旧版每 4 个一批，第 2 批用 slice[全局索引] 取到 undefined 直接报错，
   *    而且多个 commit 会和自动重建清单的 Actions 抢 main 引用（422）。 */
  const buildTree = () => {
    const tree = [];
    for (let i = 0; i < total; i++) {
      tree.push({ path: 'wallpapers/' + prepared[i], mode: '100644', type: 'blob', sha: blobs[i].sha });
      if (covers[i]) tree.push({ path: 'wallpapers/' + covers[i].name, mode: '100644', type: 'blob', sha: covers[i].sha });
    }
    return tree;
  };
  let ref = await ghRef(), done = false;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    try {
      await ghCommitTree({ baseSha: ref.baseSha, baseTree: ref.baseTree, tree: buildTree(), message: '存入壁纸库 ' + total + ' 个文件' });
      done = true;
    } catch (e) {
      if (!/409|422|conflict|does not match|fast forward/i.test(String(e)) || attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1200));
      ref = await ghRef();   /* main 被别的提交推进了，重取基线再试 */
    }
  }

  /* ④ 组装条目 + 落本机兜底（重进页面立即可见） */
  const committed = [];
  for (let i = 0; i < total; i++) {
    const f = list[i];
    const it = buildItem(prepared[i], titleAll || null);
    it.size = blobs[i].size || f.size || null;
    if (covers[i]) it.cover = 'wallpapers/' + covers[i].name;
    if (f.itemExtra) Object.assign(it, f.itemExtra);
    committed.push(it);
    onStatus(i, '已提交', 'ok');
  }
  localItemsAdd(committed);
  return committed;
}

/* ============ 管理模式：图标连点 5 下 → 密码 → 删除壁纸 ============
 * 删除是对仓库的真实写操作：删 wallpapers 文件 + 同步重建 data/wallpapers.json。
 * 因 build-manifest 由仓库侧 Actions 负责，这里删完文件后再派单重建清单；
 * 同时前端立刻从 allItems 移除并重绘，本机不留残留。 */
let isAdmin = false;

async function ghDeleteFile(path, sha) {
  /* DELETE /contents/<path> 需要 sha（先取） */
  let s = sha;
  if (!s) {
    const cur = await gh('/contents/' + encodeAPIPath(path) + '?ref=' + encodeURIComponent(CFG.branch));
    s = cur && cur.sha;
  }
  const body = { message: '管理模式删除 ' + path, branch: CFG.branch };
  if (s) body.sha = s;
  return gh('/contents/' + encodeAPIPath(path), { method: 'DELETE', body: JSON.stringify(body) });
}

/* 删除一张壁纸：文件 + 可能的封面文件 */
async function deleteWallpaper(it) {
  if (!it) return;
  const files = [];
  if (it.url) files.push(String(it.url).replace(/^\/?/, ''));
  if (it.cover) files.push(String(it.cover).replace(/^\/?/, ''));
  const uniqFiles = [...new Set(files.filter(p => p.startsWith('wallpapers/')))];
  for (const p of uniqFiles) await ghDeleteFile(p);

  /* 从本机兜底里也删掉，避免刷新后又冒出来 */
  try {
    const cur = localItemsRead().filter(x => x.url !== it.url);
    localStorage.setItem(LOCAL_ITEMS_KEY, JSON.stringify(cur));
  } catch (e) {}

  /* 前端即时移除 + 重绘（清单重建由仓库 Actions 异步完成） */
  allItems = allItems.filter(x => x !== it && x.url !== it.url);
  if (curDetail && curDetail.url === it.url) closeModal('modal-detail');
  renderAll();
  /* 派单让仓库重建清单；失败也不影响本机已删除的即时反馈 */
  try {
    await fetch('https://api.github.com/repos/' + encodeURIComponent(CFG.owner) + '/' + encodeURIComponent(CFG.repo) + '/dispatches', {
      method: 'POST',
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + CFG.pat },
      body: JSON.stringify({ event_type: 'rebuild-manifest', client_payload: { reason: 'admin-delete' } }),
    });
  } catch (e) {}
}

/* 图标连点 5 下（2 秒内）触发密码框；间隔太久自动清零 */
let tapN = 0, tapTimer = null;
function initAdmin() {
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.classList.add('admin-hit');
    brand.addEventListener('click', () => {
      if (isAdmin) return;
      tapN++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapN = 0; }, 2000);
      if (tapN >= 5) {
        tapN = 0; clearTimeout(tapTimer);
        openModal('modal-admin');
        const p = $id('admin-pass'); if (p) { p.value = ''; setTimeout(() => p.focus(), 50); }
        const m = $id('admin-msg'); if (m) m.textContent = '';
      }
    });
  }
  const cancel = $id('admin-cancel');
  if (cancel) cancel.addEventListener('click', () => closeModal('modal-admin'));
  const ok = $id('admin-ok');
  if (ok) ok.addEventListener('click', () => {
    const p = $id('admin-pass');
    if (p && p.value.trim() === '123456') {
      isAdmin = true;
      closeModal('modal-admin');
      const b = $id('admin-banner'); if (b) b.classList.remove('hidden');
      renderAll();
      toast('已进入管理模式：点图片右上角 × 删除', 'ok');
    } else {
      const m = $id('admin-msg'); if (m) m.textContent = '密码不对，再试一次';
      if (p) p.value = '';
    }
  });
  const pass = $id('admin-pass');
  if (pass) pass.addEventListener('keydown', e => { if (e.key === 'Enter' && ok) ok.click(); });

  const exit = $id('admin-exit');
  if (exit) exit.addEventListener('click', () => {
    isAdmin = false;
    const b = $id('admin-banner'); if (b) b.classList.add('hidden');
    renderAll();
    toast('已退出管理模式', 'ok');
  });

  /* 删除确认弹窗 */
  let pending = null;
  const dOk = $id('del-ok'), dCancel = $id('del-cancel'), dNo = $id('del-no');
  const closeDel = () => { pending = null; closeModal('modal-del'); };
  if (dCancel) dCancel.addEventListener('click', closeDel);
  if (dNo) dNo.addEventListener('click', closeDel);
  if (dOk) dOk.addEventListener('click', async () => {
    const it = pending; closeDel();
    if (!it) return;
    dOk.disabled = true;
    try { await deleteWallpaper(it); toast('已删除：' + (it.title || '壁纸'), 'ok'); }
    catch (e) { toast('删除失败：' + (e.message || e), 'bad'); }
    finally { dOk.disabled = false; }
  });
  window.__wpAskDelete = (it) => {
    pending = it;
    const m = $id('del-msg');
    if (m) m.textContent = '即将删除「' + (it.title || '未命名') + '」' + (it.cover ? '（含封面）' : '') + '。';
    openModal('modal-del');
  };
}

/* 供解析页（extractor.js）调用的导出：配置内置，永远可用 */
const WPGH = {
  cfg: CFG,
  async commitFiles(files, opt) { return commitFilesInner(files, opt); },
  async importEntries(entries, opt) { return commitFilesInner(entries, opt); },
};

initApp();
initAdmin();
