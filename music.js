/* =====================================================================
 * music.js —— 自研音乐解析工具 v3（纯前端、零后端、可真下载）
 *
 * 支持：汽水音乐 / 网易云音乐 / QQ音乐 / 酷狗音乐 分享链接
 * 输出：平台彩色图标 + 每首歌音符图标 + 歌名/歌手/封面 + 播放器 + 一键下载
 *
 * 下载链路（实测通过，浏览器直接拿到完整 MP3 blob）：
 *   ① 本地识别链接 → 平台 + ID + 歌名（毫秒级出卡片，绝不转圈）
 *   ② 网易云链接直接用 ID；QQ/酷狗/汽水用歌名走网易云公开搜索匹配同名曲
 *      （搜索接口无 CORS，走 core.js 的 fetchJSONSmart 多通道代理竞速）
 *   ③ 公开 Meting 端点 type=url&site=netease&id=… → 302 到 https CDN，
 *      全程 Access-Control-Allow-Origin:*，前端 fetch 拿到 audio/mpeg blob
 *   ④ <a download> 保存为「歌名 - 歌手.mp3」；两个端点自动互为备份
 *
 * 说明：QQ/酷狗/汽水官方未开放直链（vkey 为空 / getdata 30020 / 页面风控），
 *      因此这三家下载的是「网易云同名版本」，界面会明确标注，不冒充原平台文件。
 *      版权归各平台及权利人所有，仅用于个人试听收藏。
 * ===================================================================== */
'use strict';

const Music = (() => {
  const NOTE = '<path d="M9 17.5V6.4l9-2V15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.4" cy="17.6" r="2.6" fill="currentColor"/><circle cx="15.4" cy="15.6" r="2.6" fill="currentColor"/>';
  const svg = (cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${NOTE}</svg>`;

  /* 公开 Meting 端点：返回 302 → https CDN，且带 ACAO:*，浏览器可直取 blob */
  const METING = [
    'https://api.qijieya.cn/meting/',
    'https://api.injahow.cn/meting/',
  ];
  const NE = 'https://music.163.com';
  const ID_CACHE = 'wp_music_neid_v1';

  const PLATS = [
    { key: 'netease', name: '网易云音乐', short: '网易云', color: '#e60026',
      test: /(?:music\.)?163\.com|163cn\.tv/i,
      glyph: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".5"/>',
      idRe: /(?:song[/=]|\bid=|songId=)(\d{5,14})/i,
      page: id => 'https://music.163.com/#/song?id=' + id },
    { key: 'qq', name: 'QQ音乐', short: 'QQ音乐', color: '#12b76a',
      test: /(?:[a-z0-9]+\.)?y\.qq\.com|qm\.qq\.com|c6\.y\.qq\.com/i,
      glyph: '<path d="M4 12a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".5"/>',
      idRe: /(?:songDetail\/|songmid=|[?#&]mid=)([A-Za-z0-9]{10,20})/i,
      page: id => 'https://y.qq.com/n/ryqq/songDetail/' + id },
    { key: 'kugou', name: '酷狗音乐', short: '酷狗', color: '#2f7bff',
      test: /kugou\.com/i,
      glyph: '<path d="M5 19V5l7 7 7-7v14" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".5"/>',
      idRe: /(?:hash=|#hash[=/])([0-9a-fA-F]{32})/i,
      page: id => 'https://www.kugou.com/song/#hash=' + id },
    { key: 'qishui', name: '汽水音乐', short: '汽水', color: '#00b8bf',
      test: /qishui\.douyin\.com|music\.douyin\.com|qishui\.com/i,
      glyph: '<path d="M4 15c2-3 4-3 6 0s4 3 6 0 3-2 4-1" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".55"/>',
      idRe: /(?:song\/|music_id=|\bid=)(\d{6,20})/i,
      page: () => 'https://qishui.douyin.com/' },
  ];

  const DEMOS = [
    { key: 'netease', url: 'https://music.163.com/song?id=33894312', text: '分享《情非得已》给你 - 群星' },
    { key: 'qq',      url: 'https://y.qq.com/n/ryqq/songDetail/001yS0N33yPm1B', text: 'QQ音乐 分享《海阔天空》- Beyond' },
    { key: 'kugou',   url: 'https://www.kugou.com/song/#hash=EFEC0563692CAF94C184248B1D83227F', text: '酷狗音乐《海阔天空》- Beyond' },
    { key: 'qishui',  url: 'https://qishui.douyin.com/song/7351234567890123456', text: '汽水音乐 分享《起风了》给你' },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const metingURL = (id, i) => METING[i || 0] + '?type=url&site=netease&id=' + encodeURIComponent(id);
  const safeName = s => (String(s.title || 'song') + (s.artist && !/官方|打开原曲/.test(s.artist) ? ' - ' + s.artist : ''))
    .replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.mp3';

  /* ===== ID 匹配缓存（第二次解析同一首歌秒出，不再打代理） ===== */
  function idCache() { try { return JSON.parse(localStorage.getItem(ID_CACHE) || '{}'); } catch (e) { return {}; } }
  function cacheId(q, id) {
    const c = idCache(); c[q.toLowerCase()] = { id, at: Date.now() };
    try { localStorage.setItem(ID_CACHE, JSON.stringify(c)); } catch (e) {}
  }
  function cachedId(q) {
    const e = idCache()[String(q || '').toLowerCase()];
    return (e && Date.now() - e.at < 7 * 864e5) ? e.id : '';
  }

  function detect(text) { return PLATS.find(p => p.test.test(String(text || ''))) || null; }
  function brand(p, size) { return `<span class="mu-brand" style="--mc:${p.color};--ms:${size || 22}px">${svg('')}${p.glyph}</span>`; }
  function extractURL(t) {
    const m = String(t || '').match(/https?:\/\/[^\s"'<>，。、）)]+/i);
    return m ? m[0] : '';
  }
  function guessText(t) {
    const s = String(t || '');
    const m = s.match(/《([^》]{1,60})》/);
    let title = m ? m[1] : '', artist = '';
    const dash = s.match(/《[^》]+》\s*[-—–]\s*([^\s,，。]{1,24})/);
    if (dash) artist = dash[1];
    if (!artist) {
      const a = s.match(/(?:分享|来自|歌手|演唱)[：:\s]*([^\s,，。\-《》]{1,24})/);
      if (a) artist = a[1];
    }
    return { title, artist };
  }
  /* 生成搜索词：去掉平台前缀和占位文案 */
  function queryOf(s) {
    const junk = /点「打开原曲」|官方收听|分享歌曲|音乐|网易云|QQ|酷狗|汽水|给你|来自/g;
    const t = String(s.title || '').replace(junk, '').trim();
    const a = String(s.artist || '').replace(junk, '').trim();
    if (!t || /^\w{8,}$/.test(t) && !s.id) return '';
    return (t + (a ? ' ' + a : '')).slice(0, 60);
  }

  /* ===== 核心：分享链接/口令 → 歌曲（纯本地，毫秒级） ===== */
  function parse(raw) {
    const url = extractURL(raw);
    const p = detect(raw) || PLATS[0];
    const m = String(raw || '').match(p.idRe);
    const id = m ? m[1] : '';
    const g = guessText(raw);
    const home = { netease: 'https://music.163.com', qq: 'https://y.qq.com', kugou: 'https://www.kugou.com', qishui: 'https://qishui.douyin.com' }[p.key];
    const s = {
      platform: p.key, platformName: p.name, color: p.color, id,
      title: g.title || (id ? p.short + ' · 歌曲 ' + id.slice(0, 12) : p.name + ' 分享歌曲'),
      artist: g.artist || '点「打开原曲」在官方收听',
      album: '', cover: '',
      neId: '', audio: '', audioAlt: '', matched: false,
      page: url || home, url: url || '',
    };
    if (id && p.key !== 'qishui') s.page = p.page(id);

    /* 网易云链接 / 缓存命中 → 卡片一出来就有可播可下的直链，零等待 */
    let neId = (p.key === 'netease' && /^\d{4,14}$/.test(id)) ? id : '';
    if (!neId) { const q = queryOf(s); if (q) neId = cachedId(q); }
    if (neId) {
      s.neId = neId;
      s.audio = metingURL(neId, 0);
      s.audioAlt = metingURL(neId, 1);
      s.matched = p.key !== 'netease';
    }
    return s;
  }

  function card(s) {
    const media = s.audio
      ? `<audio controls preload="none" src="${esc(s.audio)}"></audio>
         ${s.matched ? '<span class="mu-match">已匹配网易云同名版本</span>' : ''}`
      : '<span class="mu-noaudio">正在获取可下载音频…</span>';
    return `<div class="mu-item" style="--mc:${s.color}">
      <div class="mu-cover ${s.cover ? 'has-img' : ''}">${s.cover ? '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">' : ''}<span class="mu-note">${svg('')}</span></div>
      <div class="mu-info">
        <div class="mu-title"><span class="mu-note-sm">${svg('')}</span>${esc(s.title)}</div>
        <div class="mu-artist">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}</div>
        <div class="mu-media">${media}</div>
      </div>
      <div class="mu-actions">
        <button type="button" class="mu-btn-dl" ${s.audio ? '' : 'disabled'}>下载</button>
        <button type="button" class="mu-btn-open">打开原曲</button>
      </div>
    </div>`;
  }

  /* 后台静默预取：拿到完整 MP3 后，播放器与下载都走本地 blob。
   * 卡片本身不等它（毫秒级先渲染），1~2 秒后播放/下载都变成零等待。 */
  async function prefetch(s, row) {
    if (!s.audio || s.blobUrl || s._fetching) return;
    s._fetching = true;
    for (const u of [s.audio, s.audioAlt]) {
      if (!u) continue;
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(45000) });
        if (!r.ok) continue;
        const blob = await r.blob();
        if (!blob || blob.size < 20000) continue;
        s.blobUrl = URL.createObjectURL(blob);
        s.blobSize = blob.size;
        const a = row && row.querySelector('audio');
        if (a) { a.src = s.blobUrl; a.load(); }
        const btn = row && row.querySelector('.mu-btn-dl');
        if (btn) btn.title = '音频已就绪，点击立即保存';
        break;
      } catch (e) { /* 换备用端点 */ }
    }
    s._fetching = false;
  }

  function attachAudioFallback(row, s) {
    const a = row && row.querySelector('audio');
    if (!a || !s.audioAlt) return;
    a.addEventListener('error', () => {
      if (a.dataset.alt || s.blobUrl) return;
      a.dataset.alt = '1'; a.src = s.audioAlt; a.load();
    });
  }

  /* ===== 一键下载：真·把完整 MP3 存到手机 ===== */
  async function download(s, btn) {
    if (!s.audio) return;
    const name = safeName(s);
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = s.blobUrl ? '保存中…' : '获取中…';
    /* 预取已完成 → 直接保存，点击即完成 */
    if (s.blobUrl) {
      const a = document.createElement('a');
      a.href = s.blobUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      btn.textContent = '已保存';
      setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3500);
      return;
    }
    const urls = [s.audio, s.audioAlt, s.neId ? NE + '/song/media/outer/url?id=' + s.neId + '.mp3' : ''];
    for (const u of urls) {
      if (!u) continue;
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) continue;
        const blob = await r.blob();
        if (!blob || blob.size < 20000) continue;   // 太小 = 错误页，不算音频
        s.blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = s.blobUrl; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        /* 下载完的音频顺手给播放器，之后离线也能播 */
        const au = btn.closest('.mu-item') && btn.closest('.mu-item').querySelector('audio');
        if (au) { au.src = s.blobUrl; au.load(); }
        btn.textContent = '已保存';
        setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3500);
        return;
      } catch (e) { /* 换下一个端点 */ }
    }
    /* 全部失败：打开音频页，手机可长按保存 */
    window.open(s.audio || s.page, '_blank', 'noopener');
    btn.textContent = '长按保存';
    setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 4500);
  }

  function bindCard(row, s) {
    const dl = row.querySelector('.mu-btn-dl');
    if (dl) {
      dl.disabled = !s.audio;
      dl.onclick = () => download(s, dl);
    }
    const op = row.querySelector('.mu-btn-open');
    if (op) op.onclick = () => window.open(s.page || s.url, '_blank', 'noopener');
  }

  function renderInto(container, songs, note) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML =
      `<div class="mu-head"><span class="mu-head-t">解析结果</span><span class="mu-head-sub">${esc(note || (songs.length + ' 首'))}</span></div>` +
      '<div class="mu-list">' + songs.map(s => {
        const p = PLATS.find(x => x.key === s.platform) || PLATS[0];
        return `<div class="mu-row" data-plat="${p.key}"><div class="mu-row-hd">${brand(p, 24)}<b>${esc(p.name)}</b></div>${card(s)}</div>`;
      }).join('') + '</div>' +
      '<div class="mu-foot">四平台均可下载 MP3。QQ音乐 / 酷狗 / 汽水官方未开放直链，下载的是按歌名匹配的网易云同名版本（卡片会标注）；网易云链接为原曲。版权归原平台及权利人所有，仅用于个人试听收藏。</div>';
    box.querySelectorAll('.mu-row').forEach((row, i) => { bindCard(row, songs[i]); attachAudioFallback(row, songs[i]); });
  }

  function jsonp(url, ms) {
    return new Promise((resolve, reject) => {
      const cb = 'wpMu' + Math.random().toString(36).slice(2, 9);
      const s = document.createElement('script');
      const t = setTimeout(() => { done(); reject(new Error('timeout')); }, ms || 5000);
      function done() { clearTimeout(t); try { delete window[cb]; } catch (e) {} if (s.parentNode) s.remove(); }
      window[cb] = d => { done(); resolve(d); };
      s.src = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + cb;
      s.onerror = () => { done(); reject(new Error('jsonp error')); };
      document.head.appendChild(s);
    });
  }

  /* 网易云 JSON 接口无 CORS → 走 core.js 的多通道代理竞速 */
  async function neJSON(path, ms) {
    if (typeof fetchJSONSmart !== 'function') return null;
    ms = ms || 8000;
    try {
      return await Promise.race([
        fetchJSONSmart(NE + path, { ms }),
        new Promise(r => setTimeout(() => r(null), ms + 600)),
      ]);
    } catch (e) { return null; }
  }

  async function resolveNeId(s) {
    if (s.platform === 'netease' && /^\d{4,14}$/.test(s.id)) return s.id;
    const q = queryOf(s);
    if (!q) return '';
    const hit = cachedId(q);
    if (hit) return hit;
    const d = await neJSON('/api/search/get?type=1&s=' + encodeURIComponent(q) + '&limit=5', 8000);
    const list = (d && d.result && d.result.songs) || [];
    if (!list.length) return '';
    const id = String(list[0].id);
    cacheId(q, id);
    return id;
  }

  /* ===== 异步补元数据 + 直链（能通就补，通不了也不影响卡片） ===== */
  async function enrich(s, box, opt) {
    /* 平台元数据 */
    try {
      let x = null;
      if (s.platform === 'netease' && s.id) {
        const d = await neJSON('/api/song/detail?ids=%5B' + s.id + '%5D', 5000);
        const q = d && d.songs && d.songs[0];
        if (q) x = { title: q.name, artist: (q.artists || []).map(a => a.name).join(' / '), cover: (q.album || {}).picUrl || '', album: (q.album || {}).name || '' };
      } else if (s.platform === 'kugou' && s.id) {
        const d = await jsonp('https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=' + s.id + '&platid=4&mid=1&album_id=0', 4000).catch(() => null);
        const q = d && d.data;
        if (q && q.song_name) x = { title: q.song_name, artist: q.author_name || '', album: q.album_name || '', cover: q.img || '' };
      }
      if (x && box) {
        const row = box.querySelector('.mu-row[data-plat="' + s.platform + '"]');
        if (row) {
          Object.assign(s, x);
          const ti = row.querySelector('.mu-title');
          if (ti && x.title) ti.innerHTML = '<span class="mu-note-sm">' + svg('') + '</span>' + esc(x.title);
          const ar = row.querySelector('.mu-artist');
          if (ar) ar.textContent = [x.artist, x.album].filter(Boolean).join(' · ');
          if (x.cover) {
            const cv = row.querySelector('.mu-cover');
            if (cv && !cv.querySelector('img')) { cv.classList.add('has-img'); cv.insertAdjacentHTML('afterbegin', '<img src="' + esc(x.cover) + '" referrerpolicy="no-referrer" alt="">'); }
          }
        }
      }
    } catch (e) { /* 静默 */ }

    /* 直链 */
    if (!box) return;
    const row = box.querySelector('.mu-row[data-plat="' + s.platform + '"]');
    if (!row) return;
    const media = row.querySelector('.mu-media');
    if (!media) return;
    if (!s.audio) {
      const id = await resolveNeId(s);
      if (id) {
        s.neId = id;
        s.audio = metingURL(id, 0);
        s.audioAlt = metingURL(id, 1);
        s.matched = s.platform !== 'netease';
      }
    }
    if (s.audio) {
      media.innerHTML = `<audio controls preload="none" src="${esc(s.audio)}"></audio>` +
        (s.matched ? '<span class="mu-match">已匹配网易云同名版本</span>' : '');
      const btn = row.querySelector('.mu-btn-dl');
      if (btn) { btn.disabled = false; btn.onclick = () => download(s, btn); }
      attachAudioFallback(row, s);
      if (opt && opt.prefetch) prefetch(s, row);
    } else {
      media.innerHTML = '<span class="mu-noaudio">未匹配到可下载版本 · 点「打开原曲」收听</span>';
    }
  }

  function runInto(raw, container, opts) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return null;
    if (!String(raw || '').trim()) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="mu-err">先粘贴汽水 / 网易云 / QQ音乐 / 酷狗的分享链接。</div>';
      return null;
    }
    const s = parse(raw);
    renderInto(box, [s], opts && opts.note);
    if (!(opts && opts.noEnrich)) enrich(s, box, { prefetch: true });
    return s;
  }

  /* ===== 四平台自测：识别 + 直链就绪状态一起显示 ===== */
  function selftest(container) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return [];
    const songs = DEMOS.map(d => parse(d.url + ' ' + d.text));
    const checked = PLATS.map((p, i) => ({ p, ok: !!(songs[i] && songs[i].platform === p.key) }));
    renderInto(box, songs, '四平台自测 · ' + checked.filter(x => x.ok).length + '/4 识别通过');
    const line = document.createElement('div');
    line.className = 'mu-testline';
    line.id = 'mu-testline';
    line.innerHTML = checked.map(x => `<span class="mu-test ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✔' : '✘'} ${esc(x.p.short)}</span>`).join('') +
      '<span class="mu-test" id="mu-test-dl">下载链路检测中…</span>';
    const head = box.querySelector('.mu-head');
    if (head) head.insertAdjacentElement('afterend', line);
    /* 自测不预取整首音频（省 40MB 流量），但真发一次请求验证直链可达 */
    Promise.all(songs.map(s => enrich(s, box, { prefetch: false }))).then(async () => {
      const ready = songs.filter(s => !!s.audio).length;
      let probe = '';
      try {
        const r = await fetch(songs[0].audio, { signal: AbortSignal.timeout(12000) });
        probe = r.ok ? ' · 直链实测可用' : ' · 直链异常';
        try { if (r.body) await r.body.cancel(); } catch (e) {}
      } catch (e) { probe = ' · 直链检测超时'; }
      const el = $('mu-test-dl');
      if (el) { el.className = 'mu-test ' + (ready === 4 ? 'ok' : 'bad'); el.textContent = '可下载 ' + ready + '/4' + probe; }
    });
    return checked;
  }

  function styles() {
    if ($('music-styles')) return;
    const s = document.createElement('style');
    s.id = 'music-styles';
    s.textContent = `
.mu-plats{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 14px}
.mu-plat{display:inline-flex;align-items:center;gap:6px;border:1px solid #e6eaf1;background:#fff;border-radius:999px;padding:6px 12px 6px 6px;font-size:12px;font-weight:600;color:#4b5563;cursor:pointer;transition:.15s}
.mu-plat:hover{border-color:var(--mc);color:var(--mc);transform:translateY(-1px)}
.mu-plat .mu-brand{--ms:24px}
.mu-brand{display:inline-flex;align-items:center;justify-content:center;width:var(--ms,22px);height:var(--ms,22px);border-radius:8px;background:var(--mc);color:#fff;flex:none;position:relative;overflow:hidden}
.mu-brand svg{position:absolute;inset:0;width:100%;height:100%}
.mu-brand svg:first-child{width:76%;height:76%;margin:auto;z-index:1}
.mu-head{display:flex;align-items:center;gap:10px;margin:14px 0 10px}
.mu-head-t{font-size:15px;font-weight:800;color:#1f2937}
.mu-head-sub{font-size:11px;color:#8a94a6;margin-left:auto}
.mu-testline{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.mu-test{font-size:11px;font-weight:700;border-radius:999px;padding:4px 9px;background:#f1f4f9;color:#5b6472}
.mu-test.ok{background:#f0fdf4;color:#15803d}
.mu-test.bad{background:#fef2f2;color:#b91c1c}
.mu-list{display:flex;flex-direction:column;gap:10px}
.mu-row{background:#f8fafd;border:1px solid #e9edf4;border-radius:14px;padding:10px}
.mu-row-hd{display:flex;align-items:center;gap:6px;font-size:12px;color:#4b5563;margin-bottom:8px}
.mu-item{display:flex;gap:12px;align-items:center;background:#fff;border:1px solid #e8ecf3;border-radius:12px;padding:10px}
.mu-cover{width:62px;height:62px;border-radius:10px;flex:none;position:relative;overflow:hidden;background:linear-gradient(135deg,#a5b4fc,#f0abfc);display:flex;align-items:center;justify-content:center;color:#fff}
.mu-cover img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
.mu-cover.has-img .mu-note{display:none}
.mu-note{width:28px;height:28px;position:relative;z-index:1}
.mu-note svg{width:100%;height:100%}
.mu-info{flex:1;min-width:0}
.mu-title{display:flex;align-items:center;gap:5px;font-size:14px;font-weight:700;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mu-note-sm{width:14px;height:14px;flex:none;color:var(--mc)}
.mu-note-sm svg{width:100%;height:100%}
.mu-artist{font-size:11px;color:#8a94a6;margin:3px 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mu-media{min-height:32px}
.mu-item audio{width:100%;height:32px;display:block}
.mu-noaudio{font-size:11px;color:#98a1b0;background:#f5f7fb;border-radius:7px;padding:4px 8px;display:inline-block}
.mu-match{display:inline-block;margin-top:4px;font-size:10px;color:#b45309;background:#fffbeb;border-radius:6px;padding:2px 6px}
.mu-actions{display:flex;flex-direction:column;gap:6px;flex:none}
.mu-actions button{border:none;border-radius:9px;padding:7px 10px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
.mu-btn-dl{background:var(--mc);color:#fff}
.mu-btn-open{background:#f1f4f9;color:#5b6472}
.mu-actions button:disabled{opacity:.4;cursor:not-allowed}
.mu-foot{font-size:11px;color:#9aa3b2;margin-top:10px;line-height:1.6}
.mu-err{background:#fef2f2;color:#b91c1c;border-radius:10px;padding:10px 12px;font-size:12px}
.hidden{display:none!important}
@media(max-width:520px){.mu-item{gap:8px;padding:8px}.mu-cover{width:52px;height:52px}.mu-actions button{padding:6px 8px;font-size:11px}}
`;
    document.head.appendChild(s);
  }

  function init() {
    styles();
    const strip = $('mu-plats');
    if (strip) {
      strip.innerHTML = PLATS.map(p =>
        `<button type="button" class="mu-plat" style="--mc:${p.color}" data-demo="${p.key}" title="点一下填入示例链接">${brand(p, 24)}${esc(p.name)}</button>`).join('');
      strip.addEventListener('click', e => {
        const b = e.target.closest('[data-demo]'); if (!b) return;
        const d = DEMOS.find(x => x.key === b.dataset.demo); if (!d) return;
        const inp = $('mu-link'); if (!inp) return;
        inp.value = d.url + ' ' + d.text;
        runInto(inp.value, 'mu-result', { note: '示例解析 · ' + d.key });
      });
    }
    const inp = $('mu-link');
    const paste = $('mu-paste');
    if (paste) paste.addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (!t || !t.trim()) { inp && inp.focus(); return; }
        inp.value = t.trim();
        runInto(inp.value, 'mu-result');
      } catch (e) { inp && inp.focus(); }
    });
    const go = $('mu-go');
    if (go) go.addEventListener('click', () => runInto(inp && inp.value, 'mu-result'));
    if (inp) {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') runInto(inp.value, 'mu-result'); });
      inp.addEventListener('paste', () => setTimeout(() => runInto(inp.value, 'mu-result'), 100));
    }
    const test = $('mu-test');
    if (test) test.addEventListener('click', () => selftest('mu-result'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { parse, runInto, selftest, detect, renderInto, metingURL, PLATS, DEMOS };
})();
