'use strict';
/* =====================================================================
 * extractor.js ── 单链接解析 + 快手主页批量搬运
 * 支持：抖音/快手/哔哩哔哩/小红书
 * 核心：多通道并发竞速（直连优先），解析成功即自动存入 GitHub 壁纸库
 * ===================================================================== */

const PLATFORMS = {
  douyin:     { name: '抖音',   test: /douyin\.com|iesdouyin\.com/i,  short: /v\.douyin\.com/i },
  kuaishou:   { name: '快手',   test: /kuaishou\.com|chenzhongtech/i, short: /v\.kuaishou\.com/i },
  bilibili:   { name: '哔哩哔哩', test: /bilibili\.com|b23\.tv/i,     short: /b23\.tv/i },
  xiaohongshu:{ name: '小红书', test: /xiaohongshu\.com|xhslink\.com/i, short: /xhslink\.com/i },
};

/* ---------- 通道优先级 & 冷却（core.js 已暴露 raceFetch / fetchTextSmart / fetchJSONSmart / fetchBlobSmart） ---------- */
// orderedChannels / pxRank 已在 core.js 中定义；此处直接复用。

/* ---------- 平台检测 ---------- */
function detectPlatform(u) {
  for (const k in PLATFORMS) {
    const p = PLATFORMS[k];
    if (p.test.test(u)) return Object.assign({ key: k }, p);
  }
  return null;
}

/* ---------- 辅助：元数据/HTML ---------- */
function tryMeta(html) {
  const pick = (prop) => {
    const m = html.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]+)"', 'i')) ||
              html.match(new RegExp('<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="' + prop + '"', 'i'));
    if (!m) return '';
    return m[1].replace(/&/g, '&').trim();
  };
  const title = pick('og:title');
  const video = pick('og:video') || pick('og:video:url');
  const image = pick('og:image');
  if (video) return { kind: 'video', play: video, title, cover: image };
  if (image) return { kind: 'images', images: [image], title, cover: image };
  return null;
}

function deepCollect(node, testFn, out, depth) {
  out = out || []; depth = depth || 0;
  if (!node || depth > 7) return out;
  if (Array.isArray(node)) { node.forEach(n => deepCollect(n, testFn, out, depth + 1)); return out; }
  if (typeof node === 'object') {
    for (const k in node) {
      const v = node[k];
      if (typeof v === 'string' && testFn(k, v)) out.push(v);
      else deepCollect(v, testFn, out, depth + 1);
    }
  }
  return out;
}

function videoCandidates(obj) {
  const list = deepCollect(obj, (k, v) =>
    /^https?:\/\//i.test(v) && /\.(mp4|m3u8)(\?|#|$)/i.test(v));
  const mp4s = list.filter(u => /\.mp4/i.test(u));
  return mp4s.length ? mp4s : list;
}

function imgCandidates(obj) {
  return deepCollect(obj, (k, v) => /^https?:\/\//i.test(v) && /\.(jpe?g|png|webp)(\?|#|$)/i.test(v))
    .filter(u => !/avatar|logo|icon/i.test(u));
}

/* ---------- 抖音 4 通道（直连 > tikwm > douyin.wtf > oioweb+pearktrue）---------- */
async function parseDouyin(url) {
  /* 1) 直连（分享页 HTML 带 _ROUTER_DATA） */
  try {
    chan(1, '抖音分享页直连');
    const id = (url.match(/\/video\/(\d+)/) || url.match(/\/note\/(\d+)/) || url.match(/modal_id=(\d+)/) || [])[1];
    if (id) {
      const html = await fetchTextSmart('https://www.iesdouyin.com/share/video/' + id + '/');
      const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
      if (m) {
        const j = JSON.parse(cleanJson(m[1]));
        const item = (function findItem(o) {
          let res = null;
          deepCollect(o, (k, v) => { if (!res && v && typeof v === 'object' && (v.play_addr || v.images)) res = v; return false; });
          return res;
        })(j);
        if (item) {
          const imgs = imgCandidates(item).slice(0, 30);
          const vids = videoCandidates(item);
          const title = item.desc || '';
          if (imgs.length > 1) return { kind: 'images', images: imgs, title, cover: imgs[0] };
          if (vids.length) return { kind: 'video', play: vids[0], title, cover: imgs[0] || '' };
        }
      }
    }
  } catch (e) { /* 换通道 */ }

  /* 2) tikwm 公共 API */
  try {
    chan(2, 'tikwm API');
    const j = await fetchJSONSmart('https://api.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1');
    if (j && j.code === 0 && j.data) {
      const d = j.data;
      const imgs = Array.isArray(d.images) ? d.images.map(x => typeof x === 'string' ? x : (x && x.url)).filter(Boolean) : [];
      let play = String(d.play || d.wmplay || '');
      if (play && play.startsWith('/')) play = 'https://www.tikwm.com' + play;
      if (imgs.length) return { kind: 'images', images: imgs, title: d.title, cover: d.cover || imgs[0] };
      if (play) return { kind: 'video', play, title: d.title, cover: d.cover };
    }
  } catch (e) { /* 换通道 */ }

  /* 3) douyin.wtf 开放 API */
  try {
    chan(3, 'douyin.wtf API');
    const j = await fetchJSONSmart('https://api.douyin.wtf/api/hybrid/video_data?url=' + encodeURIComponent(url));
    const data = (j && (j.aweme_detail || j.data)) || j;
    const item = (data && (data.item_list ? data.item_list[0] : data)) || {};
    const imgs = imgCandidates(item).slice(0, 30);
    const vids = videoCandidates(item);
    const title = item.desc || item.title || '';
    if (imgs.length > 1) return { kind: 'images', images: imgs, title, cover: imgs[0] };
    if (vids.length) return { kind: 'video', play: vids[0], title, cover: imgs[0] || '' };
  } catch (e) { /* 换通道 */ }

  /* 4) oioweb+pearktrue 兜底 */
  try {
    chan(4, 'oioweb 兜底');
    const vj = await oiowebParse(url);
    if (vj) return vj;
  } catch (e) { /* 真失败了 */ }
  throw new Error('抖音全部通道失效，换段试试或直接打开原链手动保存');
}

async function oiowebParse(url) {
  const j = await fetchJSONSmart('https://api.oioweb.cn/api/common/VideoAnalysis?url=' + encodeURIComponent(url));
  const vids = videoCandidates(j).filter(u => !/\.m3u8/i.test(u));
  const imgs = imgCandidates(j).slice(0, 30);
  const title = (j && j.data && (j.data.title || j.data.douyin_title)) || '';
  if (vids.length) return { kind: 'video', play: vids[0], title };
  if (imgs.length > 1) return { kind: 'images', images: imgs, title };
  throw new Error('没有解析到可用内容');
}

/* ---------- 哔哩哔哩 ---------- */
async function parseBili(url) {
  let bv = (url.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  let aid = (url.match(/\/video\/av(\d+)/) || [])[1];
  if (!bv && !aid) throw new Error('没有找到 BV/av 号，请确认链接是视频页');
  chan(1, 'B 站 view');
  const view = await fetchJSONSmart('https://api.bilibili.com/x/web-interface/view?' +
    (bv ? 'bvid=' + bv : 'aid=' + aid));
  if (!view || view.code !== 0 || !view.data) throw new Error(view.message || '视频信息获取失败');
  bv = view.data.bvid;
  const cid = view.data.cid;
  const title = view.data.title;
  const pic = view.data.pic;
  chan(2, 'B 站 playurl qn64');
  const qns = [64, 32, 16];
  for (const qn of qns) {
    const p = await fetchJSONSmart('https://api.bilibili.com/x/player/playurl?bvid=' + bv +
      '&cid=' + cid + '&qn=' + qn + '&platform=html5&high_quality=1&otype=json');
    if (p && p.code === 0 && p.data && Array.isArray(p.data.durl) && p.data.durl.length) {
      const d = p.data.durl[0];
      return { kind: 'video', play: d.url, size: d.size, title, cover: pic };
    }
  }
  throw new Error('该视频暂时无法解析（B 站接口被反爬/需大会员，大陆网络下常见）。可用 B 站 App 内「缓存观看」');
}

/* ---------- 小红书 ---------- */
async function parseXhs(url) {
  chan(1, '小红书初始态');
  const html = await fetchTextSmart(url);
  const id = (url.match(/(?:explore|discovery\/item)\/([0-9a-f]{24})/i) || [])[1];
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})<\/script>/);
  let note = null;
  if (m) {
    try {
      const st = JSON.parse(cleanJson(m[1]));
      const map = st.noteDetailMap || {};
      note = id && map[id] && map[id].note
        ? map[id].note
        : (Object.values(map)[0] || {}).note || null;
    } catch (e) { /* 忽略 */ }
  }
  if (note) {
    const title = note.title || note.displayTitle || note.desc || '小红书笔记';
    const pickImg = (im) => im && (im.urlDefault || im.url || im.original ||
      (im.infoList && im.infoList.length ? im.infoList[im.infoList.length - 1].url : ''));
    const imgs = (note.imageList || []).map(pickImg).filter(Boolean).slice(0, 30);
    const stream = note.video && note.video.media && note.video.media.stream || null;
    let vurl = '';
    if (stream) {
      const cand = [].concat(stream.h264 || [], stream.h265 || [], stream.av1 || []);
      for (const c of cand) { if (c && c.master_url && !/\.m3u8/i.test(c.master_url)) { vurl = c.master_url; break; } }
    }
    if (vurl) return { kind: 'video', play: toHttps(vurl), title, cover: imgs[0] || '' };
    if (imgs.length) return { kind: 'images', images: imgs, title, cover: imgs[0] || '' };
  }
  chan(2, '小红书 og/备用');
  const meta = tryMeta(html);
  if (meta) {
    if (meta.kind === 'images') return Object.assign({ kind: 'images', images: meta.images }, meta);
    return Object.assign({ kind: 'video' }, meta);
  }
  chan(3, '小红书 oioweb');
  try {
    const vj = await oiowebParse(url);
    if (vj) return vj;
  } catch (e) { /* 真失败了 */ }
  throw new Error('解析失败：笔记可能需要登录或解析接口暂时不可用');
}

/* ---------- 快手（单个作品） ---------- */
async function parseKuaishou(url) {
  chan(1, '快手作品直连');
  const html = await fetchTextSmart(url);
  const meta = tryMeta(html);
  const unescaped = unescapeJsonish(html);
  const vids = findVideoURLs(unescaped);
  const title = (meta && meta.title) ||
    (html.match(/"caption"\s*:\s*"([^"]{1,120})"/) || [])[1] || '快手作品';
  if (vids.length) return { kind: 'video', play: toHttps(vids[0]), title, cover: (meta && meta.image) || '' };
  if (meta && meta.kind === 'images') return { kind: 'images', images: meta.images, title };
  chan(2, '快手公共 API');
  try {
    const vj = await oiowebParse(url);
    if (vj) return vj;
  } catch (e) { /* 到这里就真失败了 */ }
  throw new Error('解析失败：该作品可能仅 m3u8 流或需登录，可打开原链接后长按/客户端保存');
}

/* ---------- 快手主页批量（在 parseDouyin / startExtract 的 profile 判断里已调用） ---------- */
// 已在 startExtract 中：if (plat.key === 'kuaishou' && /\/profile\//.test(url)) { fetchKsProfileAll(uid); return; }
// 函数 keep-as-is: ksProfileId, kuaishouItemFromPhoto, ksFetchProfilePage, ksProfileSSR, fetchKsProfileAll
// (前端 UI 已渲染 batchRows / b-dl / b-import；importEntries 已在 app.js WPGH 里)

/* ---------- 通用工具 ---------- */
function unescapeJsonish(s) {
  return String(s).replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&/g, '&');
}
function findVideoURLs(text) {
  const all = text.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  const skip = /avatar|logo|icon|cover|image|img|static/i;
  return [...new Set(all.filter(u => /\.mp4(\?|$)/i.test(u)))].filter(u => !skip.test(u));
}
function toHttps(u) { return u ? /^http:\/\//i.test(u) ? u.replace(/^http:/i, 'https:') : u : ''; }
function extOf(url) {
  const m = String(url || '').match(/\.(jpe?g|png|webp|gif)(\?|#|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.jpg';
}
function chan(n, name) { statusBusy('通道 ' + n + ' · ' + name + '…'); }
function sanitizeName(n) { n = String(n).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim(); return n || 'file'; }
function fmtSize(n) { if (n == null || isNaN(n)) return ''; const u = ['B','KB','MB','GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i > 0 && n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; }

/* ---------- 平台解析函数挂载 ---------- */
PLATFORMS.douyin.parse = parseDouyin;
PLATFORMS.bilibili.parse = parseBili;
PLATFORMS.kuaishou.parse = parseKuaishou;
PLATFORMS.xiaohongshu.parse = parseXhs;

/* =====================================================================
 * 结果渲染 + 自动存入壁纸库
 * ===================================================================== */

let exBusy = false, curResult = null;
function setStatus(html, cls) {
  const el = $id('ex-status'); el.classList.remove('hidden'); el.classList.toggle('bad', cls === 'bad'); el.classList.toggle('ok', cls === 'ok');
  el.innerHTML = html;
}
function statusBusy(text) { setStatus('<span class="spin"></span>' + esc(text), ''); }
function hideResult() { $id('ex-result').innerHTML = ''; $id('ex-result').classList.add('hidden'); }
function showFailHelp(url) {
  $id('ex-result').classList.remove('hidden');
  $id('ex-result').innerHTML =
    `<div class="ex-actions"><button class="btn" id="fail-open">↗ 打开原链接试试</button><button class="btn" id="fail-copy">🔗 复制链接</button></div><p class="hint">小技巧：直接打开原链接后，手机长按画面 → 存储；电脑右键另存为。稍等片刻再重试解析成功率更高。</p>`;
  $id('fail-open').onclick = () => window.open(url, '_blank', 'noopener');
  $id('fail-copy').onclick = () => copyText(url);
}
function copyText(t) { navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => toast('复制失败', 'warn')); }

function renderResult(r, plat) {
  const box = $id('ex-result'); box.classList.remove('hidden');
  const title = r.title || (plat ? plat.name + ' 内容' : '解析结果');
  let media = '', countNote = '';
  if (r.kind === 'video') {
    media = `<video class="ex-video" controls playsinline preload="metadata" ${r.cover ? `poster="${escAttr(r.cover)}"` : ''} src="${escAttr(r.play)}"></video>`;
    countNote = r.images ? `<span class="st">共 ${r.images.length} 张</span>` : '';
  } else {
    countNote = `<span class="st">共 ${r.images.length} 张</span>`;
    media = '<div class="ex-imggrid">' + r.images.map((u, i) =>
      `<div class="iw"><img loading="lazy" src="${escAttr(u)}" alt="${esc(title)}"><button class="dl" data-dl="${i}">⬇</button></div>`).join('') + '</div>';
  }
  box.innerHTML =
    `<div class="ex-title">✅ ${esc(title)}</div>
     ${media}
     <div class="d-meta">${plat.name}${countNote ? ' · ' + countNote : ''}</div>
     <div class="ex-actions">
       ${r.kind === 'video'
         ? `<button class="btn primary" id="ex-dl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/></svg>下载视频</button>`
         : `<button class="btn primary" id="ex-dl-all"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/></svg>全部下载</button>`}
       ${r.kind === 'video' ? '' : '<button class="btn ghost" id="ex-dl-one">逐张下载</button>'}
       <button class="btn ghost" id="ex-open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5H18V11"/><path d="M18 6.5 11 13.5"/><path d="M9 7H7.5A2.5 2.5 0 0 0 5 9.5v7A2.5 2.5 0 0 0 7.5 19h7a2.5 2.5 0 0 0 2.5-2.5V15"/></svg>新窗口打开</button>
       <button class="btn ghost" id="ex-copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>复制直链</button>
     </div>
     <p class="hint">${isIOS
       ? 'iOS 保存技巧：视频中按住画面不放开 → 存储；若下载按钮没反应，用【新窗口打开】后长按视频/图片保存。'
       : '手机长按即可保存；电脑右键另存为。'}</p>`;

  // 绑定手动按钮（均不阻塞后续 autoImport）
  $id('ex-dl')      && ($id('ex-dl').onclick = () => downloadSmart(r.play, (r.title || 'video').slice(0, 60) + '.mp4'));
  $id('ex-dl-all')  && ($id('ex-dl-all').onclick = async () => {
    for (let i = 0; i < r.images.length; i++) {
      await downloadViaBlob(r.images[i], fileTitle(r.images[i].split('/').pop() || '') + '.jpg');
      if (i < r.images.length - 1) { await sleep(400); if (isIOS) toast('iPhone 一次只能保存一张，逐张下载中(' + (i + 1) + '/' + r.images.length + ')，请保持页面在前台', 'warn'); }
    }
    toast('✅ 批量下载完成');
  });
  $id('ex-dl-one')  && ($id('ex-dl-one').onclick = () => toast('点图片右上角的 ⬇ 按钮逐张下载'));
  $id('ex-open')    && ($id('ex-open').onclick = () => window.open(r.kind === 'video' ? r.play : r.images[0], '_blank', 'noopener'));
  $id('ex-copy')    && ($id('ex-copy').onclick = () => copyText(r.kind === 'video' ? r.play : r.images[0]));
  box.querySelectorAll('.dl').forEach(b => {
    b.onclick = () => { const u = r.images[Number(b.dataset.dl)]; downloadViaBlob(u, fileTitle(u.split('/').pop() || '') + '.jpg'); toast('⬇️ 开始下载…'); };
  });
  const v = box.querySelector('video'); if (v) v.addEventListener('error', () => {
    const note = document.createElement('p'); note.className = 'hint'; note.style.color = '#fbbf24';
    note.textContent = '预览加载失败（部分 CDN 有防盗链限制），仍可尝试【下载视频】或【新窗口打开】后手动保存。'; v.replaceWith(note);
  }, { once: true });
}

/* ---------- 自动入库（解析成功后） ---------- */
async function autoImportAfterParse(r, plat) {
  // 检查是否已配置仓库
  if (typeof WPGH === 'undefined' || !WPGH.cfg || !WPGH.cfg.pat || !WPGH.cfg.owner || !WPGH.cfg.repo) {
    toast('解析成功！想要“一键存入壁纸库”，请去 ⚙️ 设置里先填好 GitHub 用户名 / 仓库名 / 令牌。', 'warn');
    return;
  }
  try {
    statusBusy('正在把内容存入你的壁纸库…（大视频需要 1~3 分钟，请保持页面开着）');
    const entries = await resultToEntries(r, plat);
    statusBusy('内容已抓齐（' + entries.length + ' 个文件），正在提交到 GitHub 仓库…');
    const committed = await WPGH.importEntries(entries, {
      onStatus: (idx, text) => statusBusy('提交 ' + (idx + 1) + '/' + entries.length + ' · ' + text),
    });
    committed.forEach(it => { try { allItems.unshift(it); } catch (e) {} });
    try { renderAll(); } catch (e) {}
    setStatus('🎉 已自动存入壁纸库！线上生效约需 1~2 分钟。已为你切到「壁纸」页，直接下载/长按保存即可。', 'ok');
    hideResult();
    // 自动切换标签到壁纸页
    const g = document.querySelector('.tab[data-tab="gallery"]'); if (g && !g.classList.contains('active')) g.click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('已存入壁纸库 🎉');
  } catch (e) {
    setStatus('⚠️ 自动入库没成功：' + (e.message || e) + '。已切换为手动模式，下面可以直接下载。', 'bad');
  }
}

async function resultToEntries(r, plat) {
  const fid = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);
  const safe = sanitizeName((r.title || '').replace(/\s+/g, ' ').trim().slice(0, 26)) || (plat ? plat.name : '') || '作品';
  const entries = [];

  if (r.kind === 'video') {
    const base = (safe || '视频') + '-' + fid;
    // 抓取视频
    statusBusy('抓取视频文件…');
    const blob = await fetchBlobSmart(r.play, { ms: 150000 });
    if (!blob) throw new Error('视频 CDN 拒绝了跨域抓取，可点【下载视频】手动保存');
    if (blob.size > 60 * 1024 * 1024) throw new Error('视频超过 60MB（' + fmtSize(blob.size) + '），请改在电脑上用仓库网页上传');
    const e = { name: base + '.mp4', bytes: new Uint8Array(await blob.arrayBuffer()), size: blob.size, itemExtra: { title: r.title || (plat ? plat.name + ' 视频' : '视频') } };
    // 抓取封面
    if (r.cover) {
      try {
        statusBusy('抓取封面图…');
        const cb = await fetchBlobSmart(toHttps(r.cover), { ms: 40000 });
        if (cb && cb.size < 8 * 1024 * 1024) {
          e.coverName = base + '.cover' + extOf(r.cover);
          e.coverBytes = new Uint8Array(await cb.arrayBuffer());
        }
      } catch (e) { /* 封面可选 */ }
    }
    entries.push(e);
  } else {
    // 图集
    const imgs = (r.images || []).slice(0, 30);
    const base = (safe || '图集') + '-' + fid;
    for (let i = 0; i < imgs.length; i++) {
      statusBusy('抓取图片 ' + (i + 1) + '/' + imgs.length + '…');
      try {
        const blob = await fetchBlobSmart(toHttps(imgs[i]), { ms: 60000 });
        if (!blob) throw new Error('图片抓取失败');
        entries.push({ name: base + (i ? '-' + (i + 1) : '') + extOf(imgs[i]), bytes: new Uint8Array(await blob.arrayBuffer()), size: blob.size, itemExtra: { title: (r.title || '图集') + (imgs.length > 1 ? ' ' + (i + 1) : '') } });
      } catch (e) { /* 继续下一张 */ }
    }
  }
  return entries;
}

/* ---------- 快手主页批量搬运 ---------- */
const KUAISHOU_QUERY = 'query visionProfilePhotoList($pcursor:String,$userId:String,$page:String){visionProfilePhotoList(pcursor:$pcursor,userId:$userId,page:$page){result pcursor feeds{type photo{id photoId caption mainMvUrls{url} coverUrls{url} manifest{videoDuration mediaType adaptationSet{representation{width height qualityLabel url}}}}}}}';
const KUAISHOU_DETAIL_QUERY = 'query visionProfilePhotoDetail($photoId:String){visionProfilePhotoDetail(photoId:$photoId){result photo{id photoId caption mainMvUrls{url} coverUrls{url} manifest{mediaType adaptationSet{representation{width height qualityLabel url}}}}}}';
const KS_MAX = 200;

function ksProfileId(url) { return (url.match(/profile\/([A-Za-z0-9_-]+)/) || [])[1]; }

function kuaishouItemFromPhoto(p) {
  const reps = [];
  const sets = (p.manifest && p.manifest.adaptationSet) || [];
  sets.forEach(s => (s.representation || []).forEach(r => { if (r && r.url) reps.push(r); }));
  reps.sort((a, b) => (b.width || 0) - (a.width || 0));
  let play = '';
  const mp4 = reps.find(r => !/\.m3u8/i.test(r.url));
  if (mp4) play = mp4.url;
  if (!play && Array.isArray(p.mainMvUrls) && p.mainMvUrls.length) {
    const mv = typeof p.mainMvUrls[0] === 'string' ? p.mainMvUrls[0] : (p.mainMvUrls[0] || {}).url;
    if (mv && !/\.m3u8/i.test(mv)) play = mv;
  }
  const coverOf = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return '';
    const w = typeof arr[0] === 'string' ? arr[0] : (arr[0] || {}).url;
    return w ? unescapeJsonish(w) : '';
  };
  const item = {
    photoId: p.photoId || p.id || ('ks' + Math.random().toString(36).slice(2, 8)),
    title: (p.caption || '').slice(0, 80) || '快手作品',
    kind: play ? 'video' : 'image',
    url: play,
    cover: coverOf(p.coverUrls),
  };
  if (!play) {
    const imgs = deepCollect(p, (k, v) => /^https?:\/\//.test(v) && /\.(jpe?g|png|webp)(\?|#|$)/i.test(v))
      .map(unescapeJsonish)
      .filter(u => !/logo|icon/i.test(u));
    item.url = imgs[0] || '';
    item.cover = item.cover || imgs[0] || '';
  }
  return item.url ? item : null;
}

async function ksFetchProfilePage(userId, pcursor) {
  const payload = {
    operationName: 'visionProfilePhotoList',
    variables: { userId: userId, pcursor: String(pcursor || ''), page: 'profile' },
    query: KUAISHOU_QUERY,
  };
  const errs = [];
  for (const p of POST_PROXIES) {
    try {
      const r = await withTimeout(fetch(p.mk('https://www.kuaishou.com/graphql'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }), 25000);
      if (r.ok) {
        const j = await r.json();
        if (j && !j.errors && j.data && j.data.visionProfilePhotoList) return j.data.visionProfilePhotoList;
        errs.push(p.label + ':' + ((j.errors && j.errors[0] && j.errors[0].message) || '异常'));
      } else errs.push(p.label + ':HTTP' + r.status);
    } catch (e) { errs.push(p.label + ':' + (e.message || e)); }
  }
  throw new Error('GraphQL 通道失败（' + errs.slice(0, 2).join('；') + '）');
}

async function ksProfileSSR(userId) {
  const html = await fetchTextSmart('https://www.kuaishou.com/profile/' + userId);
  const m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})<\/script>/);
  if (!m) return [];
  const st = JSON.parse(cleanJson(m[1]));
  const items = [];
  for (const key in st) {
    const v = st[key];
    if (v && typeof v === 'object' && Array.isArray(v.photos)) {
      v.photos.forEach(ph => {
        let p = ph;
        if (p && typeof p === 'object' && p.$ref) p = st[p.$ref] || null;
        if (p) { const it = kuaishouItemFromPhoto(p); if (it) items.push(it); }
      });
    }
  }
  return items;
}

async function fetchKsProfileAll(userId) {
  statusBusy('正在抓取该账号的作品列表…');
  let all = [];
  try { all = await ksProfileSSR(userId); } catch (e) { /* 继续 graphql */ }

  let pcursor = '', pages = 0;
  while (pages < 16) {
    statusBusy('抓取作品列表第 ' + (pages + 1) + ' 页…');
    let d = null;
    try { d = await ksFetchProfilePage(userId, pcursor); }
    catch (e) {
      if (!all.length) throw new Error('抓取失败：' + e.message + '（快手反爬较严，稍等几分钟重试，或对单个作品用普通链接解析）');
      statusBusy('部分分页失败，先用已抓到的 ' + all.length + ' 个作品');
      break;
    }
    (d.feeds || []).forEach(f => {
      if (f && f.photo) { const it = kuaishouItemFromPhoto(f.photo); if (it) all.push(it); }
    });
    pcursor = d.pcursor;
    if (!pcursor || pcursor === '0' || pcursor === 'NO_MORE') break;
    if (all.length >= KS_MAX) break;
    pages++;
    await sleep(700);
  }

  const seen = {}, final = [];
  for (const it of all) {
    if (seen[it.photoId]) continue;
    seen[it.photoId] = 1;
    final.push(it);
    if (final.length >= KS_MAX) break;
  }
  if (!final.length) throw new Error('该主页没有抓到可下载的作品（私密账号或单一图集除外）');
  return final;
}

/* ---------- 批量列表 UI ---------- */
let batchItems = [];
const batchSel = new Set();
let batchBusy = false;

function batchRowHTML(it, i) {
  const kindLabel = it.kind === 'video' ? '视频' : '图片';
  return `<label class="brow">
    <input type="checkbox" data-b="${i}" ${batchSel.has(it.photoId) ? 'checked' : ''}>
    <img loading="lazy" src="${escAttr(it.cover)}" alt="">
    <span class="bd"><span class="bt">${esc(it.title)}</span>
      <span class="bs">${kindLabel} · ${esc(it.photoId)}</span></span>
    <span class="st" id="bs-${i}">待处理</span>
  </label>`;
}

function renderBatch(items) {
  batchItems = items;
  batchSel.clear();
  items.forEach(it => batchSel.add(it.photoId));
  const box = $id('ex-result');
  box.classList.remove('hidden');
  box.innerHTML =
    `<div class="ex-title">✅ 抓取成功：${items.length} 个作品</div>
     <p class="hint">已默认全选 📌 批量下载到设备：iPhone 一次只能允许一个下载，作品多时建议分批；「搬运到壁纸库」会把视频/图片永久存进你的 GitHub 仓库。</p>
     <div class="batch-rows">${items.map((it, i) => batchRowHTML(it, i)).join('')}</div>
     <div class="batch-bar">
       <button class="btn primary" id="b-dl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/></svg>下载选中到设备</button>
       <button class="btn primary" id="b-import"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12h14"/><path d="m13 6.5 5.5 5.5-5.5 5.5"/></svg>搬运到壁纸库</button>
       <button class="btn ghost" id="b-all">全选</button>
       <button class="btn ghost" id="b-none">取消全选</button>
     </div>`;
  box.querySelectorAll('input[data-b]').forEach(cb => {
    cb.addEventListener('change', () => {
      const it = batchItems[Number(cb.dataset.b)];
      if (cb.checked) batchSel.add(it.photoId); else batchSel.delete(it.photoId);
    });
  });
  $id('b-all').onclick = () => { items.forEach(it => batchSel.add(it.photoId)); syncBoxes(); };
  $id('b-none').onclick = () => { batchSel.clear(); syncBoxes(); };
  $id('b-dl').onclick = batchDownload;
  $id('b-import').onclick = batchImport;
}

function syncBoxes() {
  $$('#ex-result input[data-b]').forEach(cb => {
    const it = batchItems[Number(cb.dataset.b)];
    cb.checked = batchSel.has(it.photoId);
  });
}

function batchStatus(i, text, cls) {
  const el = $id('bs-' + i);
  if (el) { el.textContent = text; el.className = 'st ' + (cls || ''); }
}

async function batchDownload() {
  if (batchBusy) return;
  const list = batchItems.map((it, i) => ({ it, i })).filter(x => batchSel.has(x.it.photoId));
  if (!list.length) { toast('先勾选要下载的作品', 'warn'); return; }
  batchBusy = true;
  let okN = 0, failN = 0;
  for (const x of list) {
    batchStatus(x.i, '下载中…', 'busy');
    const name = 'ks' + x.it.photoId + (x.it.kind === 'video' ? '.mp4' : '.jpg');
    let ok = false;
    try { ok = await downloadViaBlob(x.it.url, name); } catch (e) { ok = false; }
    if (ok) { okN++; batchStatus(x.i, '✅ 已保存', 'ok'); }
    else { failN++; batchStatus(x.i, '⚠️ 打开手动保存', 'bad'); }
    await sleep(isIOS ? 1600 : 500);
  }
  batchBusy = false;
  toast('批量下载完成：成功 ' + okN + '，失败 ' + failN, failN ? 'warn' : 'ok');
  if (failN) setStatus('⚠️ 有 ' + failN + ' 个下载失败（CDN 防盗链或太大）。可先点开单个链接手动保存，或稍后重试。', 'bad');
}

async function batchImport() {
  if (batchBusy) return;
  if (!WPGH.ensureCfg($id('ex-status'))) {
    setStatus('「搬运到壁纸库」需要管理员：⚙️ 设置 → 输入密码 12345678 → 仓库配置里粘贴一次 GitHub 令牌（用户名/仓库名已自动填好）', 'bad');
    return;
  }
  const list = batchItems.map((it, i) => ({ it, i })).filter(x => batchSel.has(x.it.photoId));
  if (!list.length) { toast('先勾选要搬运的作品', 'warn'); return; }
  batchBusy = true;
  setStatus('<span class="spin"></span>搬运开始：先抓取内容再提交仓库，作品越多耗时越长，请保持页面打开…', '');
  const entries = [];
  let okN = 0, failN = 0;
  for (const x of list) {
    batchStatus(x.i, '抓取中…', 'busy');
    try {
      const blob = await fetchBlobSmart(x.it.url);
      if (!blob) throw new Error('抓取失败');
      if (blob.size > 60 * 1024 * 1024) throw new Error('文件超过 60MB，请手动用 GitHub 网页上传');
      const e = {
        name: 'ks' + x.it.photoId + (x.it.kind === 'video' ? '.mp4' : '.jpg'),
        bytes: new Uint8Array(await blob.arrayBuffer()),
        size: blob.size,
        itemExtra: { title: x.it.title },
      };
      if (x.it.kind === 'video' && x.it.cover) {
        try {
          const cb = await fetchBlobSmart(toHttps(x.it.cover), { ms: 30000 });
          if (cb && cb.size < 8 * 1024 * 1024) {
            e.coverName = 'ks' + x.it.photoId + '.cover' + extOf(x.it.cover);
            e.coverBytes = new Uint8Array(await cb.arrayBuffer());
          }
        } catch (e) { /* 封面可选 */ }
      }
      entries.push(e);
      okN++;
      batchStatus(x.i, '已有内容，待提交', 'busy');
    } catch (e) {
      failN++;
      batchStatus(x.i, '❌ ' + (e.message || e), 'bad');
    }
  }
  if (!entries.length) {
    batchBusy = false;
    setStatus('❌ 没有抓到任何内容：' + failN + ' 个失败。可能 CDN 限制了跨域，可改用「下载到设备」或逐个解析。', 'bad');
    return;
  }
  try {
    setStatus('<span class="spin"></span>已抓取 ' + entries.length + ' 个，正在分批提交到 GitHub 仓库…', '');
    const committed = await WPGH.importEntries(entries, {
      onStatus: (idx, text, cls) => batchStatus(list[idx] ? list[idx].i : idx, text, cls),
    });
    committed.forEach(it => { try { allItems.unshift(it); } catch (e) {} });
    if (typeof renderAll === 'function') renderAll();
    setStatus('🎉 搬运完成：' + committed.length + ' 个已永久存入仓库' +
      (failN ? '，' + failN + ' 个抓取失败' : '') +
      '。约 1~2 分钟后自动上线，去「壁纸」页刷新查看！', 'ok');
    toast('搬运完成 🎉');
  } catch (e) {
    setStatus('❌ 提交仓库失败：' + (e.message || e), 'bad');
  } finally {
    batchBusy = false;
  }
}

/* ---------- 单链接解析主入口 ---------- */
async function startExtract() {
  if (exBusy) return;
  const raw = $id('link-input').value;
  const url = extractURL(raw);
  if (!url) { toast('没有识别到链接，先粘贴再点开始哦', 'warn'); return; }
  const plat = detectPlatform(url);
  if (!plat) {
    /* 直链兜底：用户粘贴的就是 mp4/图片文件 */
    if (/\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(url)) {
      exBusy = true; hideResult();
      try {
        const r = { kind: 'video', play: url, title: decodeURIComponent(url.split('/').pop().split('?')[0]) || '直链视频', cover: '' };
        curResult = r;
        renderResult(r, { name: '直链' });
        autoImportAfterParse(r, { name: '直链' });
      } finally { exBusy = false; }
      return;
    }
    if (/\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(url)) {
      exBusy = true; hideResult();
      try {
        const r = { kind: 'images', images: [url], title: decodeURIComponent(url.split('/').pop().split('?')[0]) || '直链图片', cover: url };
        curResult = r;
        renderResult(r, { name: '直链' });
        autoImportAfterParse(r, { name: '直链' });
      } finally { exBusy = false; }
      return;
    }
    setStatus('暂不支持该链接。目前支持：抖音、快手、哔哩哔哩、小红书（含短链），以及快手主页批量搬运。', 'bad');
    return;
  }
  exBusy = true;
  hideResult();
  try {
    /* 快手主页 → 批量搬运模式 */
    if (plat.key === 'kuaishou' && /\/profile\//.test(url)) {
      const uid = ksProfileId(url);
      if (!uid) throw new Error('没识别出用户 ID，请粘贴完整的主页链接');
      statusBusy('进入批量搬运模式（' + plat.name + '用户 ' + uid + '）…');
      const items = await fetchKsProfileAll(uid);
      curResult = null;
      setStatus('📦 主页搬运模式', 'ok');
      renderBatch(items);
      return;
    }
    if (plat.key === 'douyin' && /douyin\.com\/user\//i.test(url)) {
      throw new Error('抖音主页批量暂不支持（抖音反爬更严格）。可以逐条粘贴视频/图集链接解析。');
    }
    statusBusy('识别到 ' + plat.name + '，正在解析…');
    let finalURL = url;
    if (plat.short && !/\/profile\//.test(url)) {
      statusBusy('检测到短链接，正在还原真实地址…');
      finalURL = await resolveRedirect(url);
    }
    const r = await plat.parse(finalURL, plat);
    curResult = r;
    renderResult(r, plat);
    autoImportAfterParse(r, plat); /* 后台自动入库，不阻塞界面 */
  } catch (e) {
    curResult = null;
    setStatus('❌ 解析失败：' + (e.message || e), 'bad');
    showFailHelp(url);
  } finally {
    exBusy = false;
  }
}

/* ---------- UI 绑定 ---------- */
const EX_HINTS = {
  single: '单个链接支持：抖音 · 快手 · 哔哩哔哩 · 小红书（长链、短链都行）',
  batch: '批量搬运：粘贴快手个人主页链接（kuaishou.com/profile/xxx），自动抓取该账号全部作品，可勾选下载或搬运入库',
};

function setExMode(mode) {
  const seg = $id('ex-mode');
  seg.dataset.active = mode === 'batch' ? '1' : '0';
  $$('.exmb', seg).forEach(b => b.classList.toggle('active', b.dataset.extmode === mode));
  $id('link-input').placeholder = mode === 'batch'
    ? '粘贴快手主页链接，如 kuaishou.com/profile/xxx…'
    : '把抖音 / 快手 / B站 / 小红书 的链接粘贴到这里…';
  $id('ex-hint').textContent = EX_HINTS[mode] || EX_HINTS.single;
}

function initExtractor() {
  setExMode('single');
  $id('ex-mode').addEventListener('click', e => {
    const b = e.target.closest('[data-extmode]');
    if (b) setExMode(b.dataset.extmode);
  });

  $id('btn-paste').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) {
      $id('link-input').focus(); toast('无法直接读剪贴板（权限受限），请在输入框长按粘贴', 'warn'); return;
    }
    if (!extractURL(text)) { $id('link-input').focus(); toast('剪贴板里没有链接，先去 App 里复制一下', 'warn'); return; }
    $id('link-input').value = text.trim(); toast('已粘贴，自动开始解析…'); setTimeout(startExtract, 200);
  });

  $id('btn-parse').addEventListener('click', startExtract);
  $id('btn-clear').addEventListener('click', () => { $id('link-input').value = ''; hideResult(); $id('ex-status').classList.add('hidden'); });
  $id('link-input').addEventListener('keydown', e => { if (e.key === 'Enter') startExtract(); });
  $id('link-input').addEventListener('paste', e => {
    setTimeout(() => { if (extractURL($id('link-input').value)) { toast('检测到粘贴，自动开始解析…'); setTimeout(startExtract, 200); } }, 120);
  });
}

initExtractor();