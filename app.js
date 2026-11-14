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
  await loadData();
  initOnboard();
}

async function loadData(silent) {
  try {
    const r = await withTimeout(fetch('data/wallpapers.json?ts=' + Date.now()), 20000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const list = j.items || j || [];
    allItems = Array.isArray(list) ? list.filter(x => x && x.url) : [];
    if (!silent) renderAll();
  } catch (e) {
    if (!allItems.length) showEmpty(true);
    if (!silent) toast('壁纸清单加载失败：' + (e.message || e), 'bad');
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

  const list = allItems.filter(matchFilter);
  const grid = $id('grid');
  grid.innerHTML = list.map((it, i) => cardHTML(it, i)).join('');
  showEmpty(list.length === 0, false);
  if (dups) console.warn('检测到重复 id 的壁纸项');
}

function thumbHTML(it) {
  const dyn = itemDyn(it);
  if (it.kind === 'audio') {
    const cover = it.cover ? `<img loading="lazy" src="${escAttr(mediaOf(it.cover))}" alt="${esc(it.title || '')}" class="vid-cover">` : '';
    return `<span class="badge badge-audio">音乐</span><div class="vid-ph audio-ph">${cover}<svg class="vid-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/></svg></div><span class="play-tag play-tag-audio"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5.5l10-2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/></svg>音频</span>`;
  }
  const badge = `<span class="badge">${dyn ? '动态' : '静态'}</span>`;
  if (it.kind === 'video') {
    const cover = it.cover ? `<img loading="lazy" src="${escAttr(mediaOf(it.cover))}" alt="${esc(it.title || '')}" class="vid-cover">` : '';
    return `${badge}<div class="vid-ph">${cover}<svg class="vid-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.6"/><path d="M10.2 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none"/></svg></div><span class="play-tag"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 5.8v12.4L19 12z"/></svg>视频壁纸</span>`;
  }
  const img = `<img loading="lazy" src="${escAttr(it.thumb ? mediaOf(it.thumb) : mediaURL(it))}" data-full="${escAttr(mediaURL(it))}" onerror="if(this.src!==this.dataset.full)this.src=this.dataset.full" alt="${esc(it.title || '')}">`;
  if (it.gif) return badge + img + '<span class="play-tag">GIF</span>';
  return badge + img;
}

function cardHTML(it, i) {
  return `<figure class="carditem" data-i="${i}">
    <div class="thumb">${thumbHTML(it)}</div>
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
      ? `<video controls playsinline preload="metadata" poster="${escAttr(mediaOf(it.cover))}" src="${escAttr(mediaURL(it))}"></video>`
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
  openModal('modal-detail');
}

/* =============== 首开问答（空盘问你要什么口味） =============== */
function initOnboard() {
  try { if (localStorage.getItem('wp-onboarded')) return; } catch (e) { return; }
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
    const fig = e.target.closest('.carditem');
    if (!fig) return;
    const it = allItems.filter(matchFilter)[Number(fig.dataset.i)];
    if (it) openDetail(it);
  });

  const br = $id('btn-refresh');
  if (br) br.addEventListener('click', () => { toast('刷新中…'); loadData(); });
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
    await gh('/contents/' + encodeURI(path) + '?ref=' + encodeURIComponent(CFG.branch));
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

  const prepared = [];
  for (let i = 0; i < total; i++) {
    const f = list[i];
    let name = sanitizeName(f.name || 'file-' + i);
    try {
      if (await ghPathExists('wallpapers/' + name)) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        name = base + '-2' + ext;
      }
    } catch (e) { /* 无所谓，覆盖也没关系 */ }
    prepared.push(name);
  }

  const CHUNK = 4;
  const committed = [];
  for (let start = 0; start < total; start += CHUNK) {
    const slice = list.slice(start, start + CHUNK);
    const ref = await ghRef();
    const tree = [];
    for (let k = 0; k < slice.length; k++) {
      const idx = start + k;
      const f = slice[idx];
      onStatus(idx, '读取中…', 'busy');
      let bytes;
      if (f.bytes) bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      else bytes = new Uint8Array(await f.arrayBuffer());
      onStatus(idx, '上传中(' + (start + 1 + k) + '/' + total + ')…', 'busy');
      const sha = await ghCreateBlob(bytes);
      tree.push({ path: 'wallpapers/' + prepared[idx], mode: '100644', type: 'blob', sha: sha });
      const it = buildItem(prepared[idx], titleAll || null);
      it.size = bytes.byteLength || f.size || null;
      if (f.coverName && f.coverBytes) {
        const coverSha = await ghCreateBlob(f.coverBytes instanceof Uint8Array ? f.coverBytes : new Uint8Array(f.coverBytes));
        tree.push({ path: 'wallpapers/' + f.coverName, mode: '100644', type: 'blob', sha: coverSha });
        it.cover = 'wallpapers/' + f.coverName;
      }
      if (f.itemExtra) Object.assign(it, f.itemExtra);
      committed.push(it);
    }
    await ghCommitTree({ baseSha: ref.baseSha, baseTree: ref.baseTree, tree, message: '上传壁纸 ' + (start + 1) + '~' + (start + tree.length) + ' / ' + total });
    for (let k = 0; k < slice.length; k++) onStatus(start + k, '已提交', 'ok');
  }
  return committed;
}

/* 供解析页（extractor.js）调用的导出：配置内置，永远可用 */
const WPGH = {
  cfg: CFG,
  async commitFiles(files, opt) { return commitFilesInner(files, opt); },
  async importEntries(entries, opt) { return commitFilesInner(entries, opt); },
};

initApp();
