'use strict';
/* =====================================================================
 * app.js —— 画廊渲染 / 详情弹窗 / 设置（管理员）/ GitHub 提交
 * ===================================================================== */

const ADMIN_CFG_KEY = 'wp_admin_cfg_v1';
/* 站点内置默认仓库（公开信息，随站点交付；令牌 PAT 仍需本机填写） */
const SITE_DEFAULTS = { owner: '1yk8u', repo: 'wallpaper', branch: 'main' };
const UNLOCK_KEY = 'wp_unlocked_v1';
const DEFAULT_ADMIN_PWD = '12345678';
const PWD_SALT = 'wp-site::v1::';

let adminCfg = null;      // {owner, repo, branch, pat}
let unlocked = false;
let pwdHash = null;       // null => 默认密码 12345678
let allItems = [];
let curType = 'all';
let curQ = '';
let curCat = 'all';          /* 分类筛选（首开问答后可只显示某一类） */
const CAT_LIST = ['全部', '二次元', '汽车', '风景', '萌宠', '游戏', '文字', '综合'];

/* =============== 初始化 =============== */
async function initApp() {
  if (location.protocol === 'file:') $id('file-banner').classList.remove('hidden');
  try { adminCfg = JSON.parse(localStorage.getItem(ADMIN_CFG_KEY) || 'null'); } catch (e) { adminCfg = null; }
  unlocked = sessionStorage.getItem(UNLOCK_KEY) === '1';
  bindUI();
  await loadPwdHash();
  fillCfgForm();
  refreshSettingsView();
  await loadData();
  initOnboard();
}

async function loadPwdHash() {
  try {
    const r = await withTimeout(fetch('data/config.json?ts=' + Date.now()), 15000);
    if (r.ok) {
      const j = await r.json();
      if (j && j.pwd) pwdHash = j.pwd;
    }
  } catch (e) { /* 没有 config.json => 默认密码 */ }
}

async function checkPwd(p) {
  if (!p) return false;
  try {
    const h = await sha256Hex(PWD_SALT + p);
    if (pwdHash) return h === pwdHash;
  } catch (e) { /* file:// 下 crypto 可能受限，退回明文比较 */ }
  return p === DEFAULT_ADMIN_PWD;
}

/* =============== 数据 =============== */
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
  /* 与 mediaOf 同一编码规则（# → %23），下载/详情/视频统一走这里 */
  return mediaOf(it && it.url);
}

function itemDyn(it) { return it.kind === 'video' || it.gif === true; }

function matchFilter(it) {
  if (curType === 'image' && itemDyn(it)) return false;
  if (curType === 'video' && !itemDyn(it)) return false;
  if (curCat !== 'all' && (it.cat || '综合') !== curCat) return false;
  if (curQ && !(it.title || '').toLowerCase().includes(curQ)) return false;
  return true;
}

/* 分类条：按库内实际存在的品类渲染（含计数），第二条筛选维度 */
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
    if (curCat !== 'all' && counts[curCat] < 8) toast('「' + curCat + '」目前存货还不多，管理员会继续收集', 'warn');
  }));
}

function renderAll() {
  /* 分类条随库重绘 */
  renderCatChips();
  const seen = {};
  allItems.forEach(it => { if (it.id) seen[it.id] = (seen[it.id] || 0) + 1; });
  const dups = Object.values(seen).some(n => n > 1);
  const nAll = allItems.length;
  let nImg = 0, nVid = 0;
  allItems.forEach(it => itemDyn(it) ? nVid++ : nImg++);
  $id('cnt-all').textContent = nAll ? '(' + nAll + ')' : '';
  $id('cnt-image').textContent = nImg ? '(' + nImg + ')' : '';
  $id('cnt-video').textContent = nVid ? '(' + nVid + ')' : '';

  const list = allItems.filter(matchFilter);
  const grid = $id('grid');
  grid.innerHTML = list.map((it, i) => cardHTML(it, i)).join('');
  showEmpty(list.length === 0, false);
  if (dups) console.warn('检测到重复 id 的壁纸项');
}

function thumbHTML(it) {
  const dyn = itemDyn(it);
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
  if (it.kind === 'video') {
    m.innerHTML = it.cover
      ? `<video controls playsinline preload="metadata" poster="${escAttr(mediaOf(it.cover))}" src="${escAttr(mediaURL(it))}"></video>`
      : `<video controls playsinline preload="metadata" src="${escAttr(mediaURL(it))}"></video>`;
  } else {
    m.innerHTML = `<img src="${escAttr(mediaURL(it))}" alt="${esc(it.title || '')}">`;
  }
  const bits = [];
  bits.push(dyn ? '动态壁纸' : '静态壁纸');
  if (it.kind === 'video' && it.gif !== true) bits.push('视频');
  if (it.gif) bits.push('GIF');
  if (it.size) bits.push(fmtSize(it.size));
  if (it.date) { try { bits.push(String(it.date).slice(0, 10)); } catch (e) {} }
  if (it.src === 'link') bits.push('外链');
  $id('d-meta').textContent = bits.join(' · ');
  $id('d-tip').textContent = isIOS
    ? 'iPhone 提示：点下载保存图片；视频请在【新窗口打开】后长按 → 存储视频。'
    : '手机可长按图片/视频保存；电脑也可右键另存为。';
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
  /* 选项卡（同步分段滑块） */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    const seg = t.closest('.seg');
    if (seg) seg.dataset.active = String($$('.tab', seg).indexOf(t));
    $$('.page').forEach(p => p.classList.remove('active'));
    $id('tab-' + t.dataset.tab).classList.add('active');
    window.scrollTo(0, 0);
  }));

  /* 筛选 */
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

  $id('btn-refresh').addEventListener('click', () => { toast('刷新中…'); loadData(); });
  $id('btn-reload').addEventListener('click', () => loadData());

  /* 详情弹窗 */
  const md = $id('modal-detail');
  md.addEventListener('click', e => { if (e.target === md) closeModal('modal-detail'); });
  $id('btn-close-detail').addEventListener('click', () => closeModal('modal-detail'));
  $id('d-download').addEventListener('click', () => {
    if (!curDetail) return;
    const name = decodeURIComponent((curDetail.url || '').split('/').pop()) || 'wallpaper';
    downloadSmart(mediaURL(curDetail), name);
  });
  $id('d-open').addEventListener('click', () => { if (curDetail) window.open(mediaURL(curDetail), '_blank', 'noopener'); });

  /* 设置弹窗 */
  const ms = $id('modal-settings');
  ms.addEventListener('click', e => { if (e.target === ms) closeModal('modal-settings'); });
  $id('btn-close-settings').addEventListener('click', () => closeModal('modal-settings'));
  $id('btn-settings').addEventListener('click', () => { refreshSettingsView(); openModal('modal-settings'); });
  $id('admin-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  $id('btn-unlock').addEventListener('click', tryUnlock);
  $id('btn-lock').addEventListener('click', () => {
    unlocked = false;
    sessionStorage.removeItem(UNLOCK_KEY);
    refreshSettingsView();
    closeModal('modal-settings');
    toast('已锁定设置');
  });

  /* 仓库配置 */
  $id('btn-save-cfg').addEventListener('click', saveCfg);
  $id('btn-test-cfg').addEventListener('click', testCfg);

  /* 上传 */
  $id('up-files').addEventListener('change', e => renderUpRows(e.target.files));
  $id('btn-upload').addEventListener('click', doUpload);

  /* 直链 */
  $id('btn-add-link').addEventListener('click', addLink);

  /* 管理 */
  $id('btn-manage').addEventListener('click', renderManage);
  $id('manage-search').addEventListener('input', renderManage);

  /* 改密码 */
  $id('btn-chg-pwd').addEventListener('click', changePwd);
}

/* =============== 设置：解锁 =============== */
function refreshSettingsView() {
  $id('settings-lock').classList.toggle('hidden', unlocked);
  $id('settings-body').classList.toggle('hidden', !unlocked);
}

async function tryUnlock() {
  const btn = $id('btn-unlock');
  if (btn.disabled) return;
  const p = $id('admin-pwd').value;
  const msg = $id('lock-msg');
  if (!p) { msg.textContent = '请输入密码'; msg.className = 'msg bad'; return; }
  msg.textContent = '校验中…'; msg.className = 'msg';
  btn.disabled = true;
  try {
    const ok = await checkPwd(p);
    if (ok) {
      msg.textContent = '校验通过';
      msg.className = 'msg ok';
      unlocked = true;
      sessionStorage.setItem(UNLOCK_KEY, '1');
      $id('admin-pwd').value = '';
      refreshSettingsView();
      toast('已解锁管理员设置');
    } else {
      msg.textContent = '密码错误';
      msg.className = 'msg bad';
    }
  } finally {
    btn.disabled = false;
  }
}

/* =============== 设置：仓库配置 =============== */
function fillCfgForm() {
  const c = adminCfg || SITE_DEFAULTS;
  $id('cfg-owner').value = c.owner || SITE_DEFAULTS.owner;
  $id('cfg-repo').value = c.repo || SITE_DEFAULTS.repo;
  $id('cfg-branch').value = c.branch || SITE_DEFAULTS.branch;
  $id('cfg-pat').value = (adminCfg && adminCfg.pat) || '';
}

function saveCfg() {
  const pat = $id('cfg-pat').value.trim();
  const msg = $id('cfg-msg');
  if (!pat) {
    msg.textContent = '请填写 GitHub 令牌（PAT）哦 —— 用户名 / 仓库名已自动填好';
    msg.className = 'msg bad';
    return;
  }
  adminCfg = Object.assign({}, SITE_DEFAULTS, {
    owner: $id('cfg-owner').value.trim() || SITE_DEFAULTS.owner,
    repo: $id('cfg-repo').value.trim() || SITE_DEFAULTS.repo,
    branch: $id('cfg-branch').value.trim() || SITE_DEFAULTS.branch,
    pat,
  });
  localStorage.setItem(ADMIN_CFG_KEY, JSON.stringify(adminCfg));
  msg.textContent = '已保存（令牌仅保存在本机浏览器）';
  msg.className = 'msg ok';
}

async function testCfg() {
  const msg = $id('cfg-msg');
  if (!adminCfg) { msg.textContent = '请先保存配置'; msg.className = 'msg bad'; return; }
  msg.textContent = '连接中…'; msg.className = 'msg';
  try {
    const j = await gh('/contents/data?ref=' + encodeURIComponent(adminCfg.branch));
    msg.textContent = '连接成功，访问仓库 ' + adminCfg.owner + '/' + adminCfg.repo + ' 正常';
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = '' + (e.message || e) + '（401=令牌无效；404=仓库/分支不存在）';
    msg.className = 'msg bad';
  }
}

/* =============== GitHub API 封装 =============== */
function ghHeaders(extra) {
  return Object.assign({
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + (adminCfg.pat || ''),
  }, extra || {});
}
function apiURL(path) {
  return 'https://api.github.com/repos/' + encodeURIComponent(adminCfg.owner) +
    '/' + encodeURIComponent(adminCfg.repo) + path;
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
  const ref = await gh('/git/ref/heads/' + encodeURIComponent(adminCfg.branch));
  const c = await gh('/git/commits/' + ref.object.sha);
  return { baseSha: ref.object.sha, baseTree: c.tree.sha };
}

async function ghCreateBlob(bytes) {
  const b = await gh('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: bytesToB64(bytes), encoding: 'base64' }),
  });
  return b.sha;
}

async function ghCommitTree(o) {
  const t = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: o.baseTree, tree: o.tree }),
  });
  const c = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: o.message, tree: t.sha, parents: [o.baseSha] }),
  });
  await gh('/git/refs/heads/' + encodeURIComponent(adminCfg.branch), {
    method: 'PATCH',
    body: JSON.stringify({ sha: c.sha, force: false }),
  });
  return c.sha;
}

async function ghPathExists(path) {
  try {
    await gh('/contents/' + encodeURI(path) + '?ref=' + encodeURIComponent(adminCfg.branch));
    return true;
  } catch (e) {
    if (/404/.test(String(e))) return false;
    throw e;
  }
}

async function ghDeleteFile(path, message) {
  const meta = await gh('/contents/' + encodeURI(path) + '?ref=' + encodeURIComponent(adminCfg.branch));
  await gh('/contents/' + encodeURI(path), {
    method: 'DELETE',
    body: JSON.stringify({ message: message || ('删除 ' + path), sha: meta.sha, branch: adminCfg.branch }),
  });
}

/* 读取/写入 data/links.json（直链清单，用 contents API 整文件替换） */
async function linksGet() {
  try {
    const j = await gh('/contents/data/links.json?ref=' + encodeURIComponent(adminCfg.branch));
    return { sha: j.sha, arr: JSON.parse(b64ToUtf8(j.content)) };
  } catch (e) {
    if (/404/.test(String(e))) return { sha: null, arr: [] };
    throw e;
  }
}
async function linksPut(arr, message) {
  const st = await linksGet();
  await gh('/contents/data/links.json', {
    method: 'PUT',
    body: JSON.stringify({
      message: message,
      content: utf8ToB64(JSON.stringify(arr, null, 2)),
      branch: adminCfg.branch,
      sha: st.sha || undefined,
    }),
  });
}

/* =============== 上传（本地文件 → 仓库） =============== */
function extInfo(name) {
  if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return { kind: 'video', gif: false };
  if (/\.gif$/i.test(name)) return { kind: 'image', gif: true };
  return { kind: 'image', gif: false };
}

function buildItem(name, title) {
  const info = extInfo(name);
  return {
    id: 'wp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name,
    title: title || fileTitle(name),
    kind: info.kind,
    gif: info.gif,
    url: 'wallpapers/' + name,
    size: null,
    date: new Date().toISOString(),
    src: 'file',
  };
}

let uploadQueue = [];

function renderUpRows(fileList) {
  const box = $id('up-rows');
  uploadQueue = Array.from(fileList || []);
  box.innerHTML = uploadQueue.map((f, i) =>
    `<div class="mrow">
      <span class="name">${esc(f.name)}</span>
      <span class="sub">${fmtSize(f.size)} · ${esc(extInfo(f.name).kind === 'video' ? '动态' : '静态')}</span>
      <span class="st" id="upst-${i}">待上传</span>
    </div>`).join('');
}

async function doUpload() {
  const msg = $id('up-msg');
  if (!ensureCfg(msg)) return;
  if (!uploadQueue.length) { toast('请先选择文件', 'warn'); return; }
  const btn = $id('btn-upload');
  btn.disabled = true;
  msg.textContent = '准备上传 ' + uploadQueue.length + ' 个文件…'; msg.className = 'msg';
  try {
    const title = $id('up-title').value.trim();
    const stored = await WPGH.commitFiles(uploadQueue, {
      title,
      onStatus: (i, text, cls) => {
        const el = $id('upst-' + i);
        if (el) { el.textContent = text; el.className = 'st ' + (cls || ''); }
      },
    });
    stored.forEach(it => allItems.unshift(it));
    renderAll();
    $id('up-files').value = '';
    $id('up-rows').innerHTML = '';
    uploadQueue = [];
    msg.textContent = '已提交到仓库！约 1~2 分钟后正式上线（之后刷新页面即可看到）';
    msg.className = 'msg ok';
    toast('上传提交成功，稍后自动上线');
  } catch (e) {
    msg.textContent = '上传失败：' + (e.message || e);
    msg.className = 'msg bad';
  } finally {
    btn.disabled = false;
  }
}

function ensureCfg(msgEl) {
  if (adminCfg && adminCfg.pat && adminCfg.owner && adminCfg.repo) return true;
  const m = '请先填好上方的「仓库配置」再操作';
  if (msgEl) { msgEl.textContent = m; msgEl.className = 'msg bad'; }
  toast(m, 'warn');
  $id('cfg-owner').scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

/* =============== 直链管理 =============== */
async function addLink() {
  const msg = $id('link-msg');
  if (!ensureCfg(msg)) return;
  const url = $id('link-url').value.trim();
  if (!/^https?:\/\//i.test(url)) { msg.textContent = '请填写 http(s) 开头的直链'; msg.className = 'msg bad'; return; }
  const entry = {
    id: 'lk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: $id('link-title').value.trim() || '直链壁纸',
    kind: $id('link-type').value,
    gif: false,
    url: url,
    date: new Date().toISOString(),
    src: 'link',
  };
  msg.textContent = '保存中…'; msg.className = 'msg';
  try {
    const st = await linksGet();
    const arr = st.arr.filter(x => x.url !== url);      // 去重
    arr.unshift(entry);
    await linksPut(arr, '管理：添加直链 ' + fileTitle(entry.url.split('/').pop() || ''));
    allItems.unshift(entry);
    renderAll();
    $id('link-url').value = ''; $id('link-title').value = '';
    msg.textContent = '直链已保存，网站约 1~2 分钟后更新';
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = '' + (e.message || e);
    msg.className = 'msg bad';
  }
}

/* =============== 内容管理 =============== */
async function renderManage() {
  $id('btn-manage').textContent = '加载中…';
  const q = ($id('manage-search').value || '').trim().toLowerCase();
  const box = $id('manage-rows');
  box.innerHTML = allItems
    .filter(it => !q || (it.title || '').toLowerCase().includes(q) || (it.url || '').toLowerCase().includes(q))
    .map(it =>
      `<div class="mrow">
        <span class="name">${esc(it.title || '')}</span>
        <span class="tag ${it.src === 'link' ? 'link' : ''}">${it.src === 'link' ? '直链' : '仓库文件'}</span>
        <button class="btn danger" data-del="${esc(it.id)}">删除</button>
      </div>`).join('') ||
    '<p class="hint">空空如也</p>';
  $id('btn-manage').textContent = '↻ 加载列表';
}

async function deleteItem(id) {
  const it = allItems.find(x => x.id === id);
  if (!it) return;
  if (!confirm('确定删除「' + (it.title || '') + '」吗？')) return;
  toast('删除中…');
  try {
    if (it.src === 'link') {
      const st = await linksGet();
      await linksPut(st.arr.filter(x => x.id !== id), '管理：删除直链');
    } else {
      await ghDeleteFile(it.url);
    }
    allItems = allItems.filter(x => x.id !== id);
    renderAll();
    renderManage();
    toast('已删除，仓库部署完成后网站自动更新');
  } catch (e) {
    toast('删除失败：' + (e.message || e), 'bad');
  }
}

/* =============== 修改密码 =============== */
async function changePwd() {
  const msg = $id('pwd-msg');
  const old1 = $id('old-pwd').value, neo = $id('new-pwd').value;
  if (!old1 || !neo) { msg.textContent = '请填写当前密码和新密码'; msg.className = 'msg bad'; return; }
  if (neo.length < 6) { msg.textContent = '新密码至少 6 位'; msg.className = 'msg bad'; return; }
  msg.textContent = '校验当前密码…'; msg.className = 'msg';
  if (!(await checkPwd(old1))) { msg.textContent = '当前密码不对哦'; msg.className = 'msg bad'; return; }
  try {
    const h = await sha256Hex(PWD_SALT + neo);
    const path = 'data/config.json';
    let sha;
    try { sha = (await gh('/contents/' + path + '?ref=' + encodeURIComponent(adminCfg.branch))).sha; } catch (e) {}
    await gh('/contents/' + path, {
      method: 'PUT',
      body: JSON.stringify({
        message: '管理：修改管理员密码',
        content: utf8ToB64(JSON.stringify({ pwd: h })),
        branch: adminCfg.branch,
        sha: sha,
      }),
    });
    pwdHash = h;
    $id('old-pwd').value = ''; $id('new-pwd').value = '';
    msg.textContent = '密码已修改，全网生效约需 1~2 分钟。请记住新密码！';
    msg.className = 'msg ok';
  } catch (e) {
    msg.textContent = '修改失败：' + (e.message || e);
    msg.className = 'msg bad';
  }
}

/* =============== 供批量搬运调用的导出 =============== */
const WPGH = {
  get cfg() { return adminCfg; },
  ensureCfg,
  async commitFiles(files, opt) {
    return commitFilesInner(files, opt);
  },
  async importEntries(entries, opt) {
    return commitFilesInner(entries, opt);
  },
};

/* files: File[] 或 [{name, bytes(Uint8Array|ArrayBuffer), size, itemExtra, coverName, coverBytes}] */
async function commitFilesInner(config, opt) {
  const cl = config;
  const list = Array.from(cl || []);
  const total = list.length;
  if (!total) return [];
  const onStatus = opt.onStatus || (() => {});
  const fileTitle_ = opt.title || '';

  const prepared = [];
  const big = list.find(f => (f.size || f._size || 0) > 60 * 1024 * 1024);
  if (big) throw new Error('存在超过 60MB 的文件，请改用 GitHub 网页端上传（wallpapers 文件夹直接拖入）');

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

  await (opt.before || Promise.resolve());

  /* 分批提交，每批 4 个文件一个 commit */
  const CHUNK = 4;
  const committed = [];
  for (let start = 0; start < total; start += CHUNK) {
    await (opt.before || Promise.resolve());
    const slice = list.slice(start, start + CHUNK);
    const ref = await ghRef();
    const tree = [];
    for (let k = 0; k < slice.length; k++) {
      const idx = start + k;
      const f = slice[idx];
      onStatus(idx, '读取中…', 'busy');
      let bytes;
      if (f.bytes) {
        bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      } else {
        bytes = new Uint8Array(await f.arrayBuffer());
      }
      onStatus(idx, '上传中(' + (start + 1 + k) + '/' + total + ')…', 'busy');
      const sha = await ghCreateBlob(bytes);
      tree.push({ path: 'wallpapers/' + prepared[idx], mode: '100644', type: 'blob', sha: sha });
      const it = buildItem(prepared[idx], fileTitle_ || null);
      it.size = bytes.byteLength || f.size || null;
      if (f.coverName && f.coverBytes) {
        const coverSha = await ghCreateBlob(f.coverBytes instanceof Uint8Array ? f.coverBytes : new Uint8Array(f.coverBytes));
        tree.push({ path: 'wallpapers/' + f.coverName, mode: '100644', type: 'blob', sha: coverSha });
        it.cover = 'wallpapers/' + f.coverName;
      }
      if (f.itemExtra) Object.assign(it, f.itemExtra);
      committed.push(it);
    }
    await ghCommitTree({
      baseSha: ref.baseSha, baseTree: ref.baseTree, tree,
      message: '上传壁纸 ' + (start + 1) + '~' + (start + tree.length) + ' / ' + total,
    });
    for (let k = 0; k < slice.length; k++) onStatus(start + k, '已提交', 'ok');
  }
  return committed;
}

async function deleteById(id) { return deleteItem(id); }

/* 画廊上的删除入口代理到 settings 的实现 */
$id('manage-rows').addEventListener('click', e => {
  const b = e.target.closest('[data-del]');
  if (b) deleteItem(b.dataset.del);
});

initApp();
