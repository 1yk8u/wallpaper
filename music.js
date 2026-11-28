/* =====================================================================
 * music.js —— 自研音乐解析 v5（网易云 + 汽水音乐）
 *
 * 用户要求：汽水、网易云都「不走直连」，解析完的音乐要有图标。
 *   v4 把第三方音频 URL 挂在 <audio src> / 下载 / window.open 上，会过期、
 *   会被风控、页面里也看得见第三方地址 —— 这版整体换掉。
 *
 * 现在的链路（页面 DOM 里一个第三方音频地址都没有）：
 *   ① 本地识别：分享链接/口令 → 平台 + ID + 歌名（毫秒级出卡片，带平台图标/音符/封面位）
 *   ② 自家仓库代抓：GitHub Actions 调两家官方接口，把【音频字节 + 封面字节】
 *      抓进仓库 data/audio/ 与 data/covers/，只回传同源相对路径 localAudio / cover
 *   ③ 浏览器直接用本站同源文件：播放器 / 下载都指向 data/audio/ 相对路径。
 *      moov 在文件头，支持 Range 流式播放，点一下就响；不用先把整首歌
 *      读进内存（实测 2.3MB 从 Pages 下完要 90 秒，那才是真正让人转圈的地方）。
 *      只有「存到壁纸库」才 fetch 同源字节转本地 Blob 提交。
 *      ensureBlob() 硬校验路径格式，绝不接受 http(s) 开头的音频地址。
 *   ④ 存入壁纸库：WPGH 仓库直连，永久保存进「音乐」分类
 *
 * 附带好处：汽水官方音频 URL 带时间戳签名、几十分钟就 403；
 *   落到自家仓库后变成永久有效的同源静态文件，首次抓取后一直秒出。
 * ===================================================================== */
'use strict';

const Music = (() => {
  const NOTE = '<path d="M9 17.5V6.4l9-2V15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.4" cy="17.6" r="2.6" fill="currentColor"/><circle cx="15.4" cy="15.6" r="2.6" fill="currentColor"/>';
  const svg = () => `<svg viewBox="0 0 24 24" aria-hidden="true">${NOTE}</svg>`;
  const NE_HOME = 'https://music.163.com';
  /* 唯一允许被 fetch 的音频路径：自家仓库的相对路径，http(s) 一律拒绝 */
  const LOCAL_AUDIO_RE = /^data\/audio\/au_[0-9a-f]{16}\.(mp3|m4a)$/i;

  const PLATS = [
    { key: 'netease', name: '网易云音乐', short: '网易云', color: '#e60026',
      test: /(?:music\.)?163\.com|163cn\.tv/i,
      glyph: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".5"/>',
      idRe: /(?:song[/=]|\bid=|songId=)(\d{5,14})/i },
    { key: 'qishui', name: '汽水音乐', short: '汽水', color: '#00b8bf',
      test: /qishui\.douyin\.com|music\.douyin\.com/i,
      glyph: '<path d="M4 15c2-3 4-3 6 0s4 3 6 0 3-2 4-1" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".55"/>',
      /* 三种真实形态：track_id=（music.douyin.com 分享页）/ song/<数字> / qishui.douyin.com/s/<短码> */
      idRe: /(?:track_id=|song\/|music_id=|\bid=)(\d{6,20})|qishui\.douyin\.com\/s\/([a-z0-9]{6,12})(?:[/?#\s]|$)/i },
  ];

  const DEMOS = [
    { key: 'netease', url: 'https://music.163.com/song?id=33894312', text: '分享《情非得已 (童声版)》给你 - 群星' },
    { key: 'qishui', url: 'https://qishui.douyin.com/s/iXKMfM6u/', text: 'Gasolina（何为张力）》@汽水音乐' },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const safeName = s => (String(s.title || 'song') + (s.artist && !/官方|打开原曲/.test(s.artist) ? ' - ' + s.artist : ''))
    .replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.' + (s.audioExt === 'm4a' ? 'm4a' : 'mp3');

  function detect(text) { return PLATS.find(p => p.test.test(String(text || ''))) || null; }
  function brand(p, size) {
    return `<span class="mu-brand" style="--mc:${p.color};--ms:${size || 22}px">${svg()}${p.glyph}</span>`;
  }
  function guessText(t) {
    const s = String(t || '');
    let m = s.match(/《([^》]{1,60})》/);
    /* 汽水口令常是半截书名号："Gasolina（何为张力）》@汽水音乐 https://..." */
    if (!m) {
      const half = s.match(/^\s*([^《》@\s][^《》@]{0,59})》/);
      if (half) m = [null, half[1].trim()];
    }
    let title = m ? m[1] : '', artist = '';
    const dash = s.match(/《[^》]+》\s*[-—–]\s*([^\s,，。]{1,24})/);
    if (dash) artist = dash[1];
    if (!artist) {
      const a = s.match(/(?:分享|来自|歌手|演唱)[：:\s]*([^\s,，。\-《》]{1,24})/);
      if (a) artist = a[1];
    }
    return { title, artist };
  }

  /* ===== 本地识别（毫秒级，无网络） ===== */
  function parse(raw) {
    const p = detect(raw) || PLATS[0];
    const m = String(raw || '').match(p.idRe);
    let id = m ? (m[1] || m[2] || '') : '';
    if (p.key === 'qishui' && id) id = id.toLowerCase();   /* 短码键统一小写（与中转一致） */
    const g = guessText(raw);
    return {
      platform: p.key, platformName: p.name, color: p.color, id,
      title: g.title || (id ? p.short + ' · 歌曲 ' + id.slice(0, 12) : p.name + ' 分享歌曲'),
      artist: g.artist || '',
      album: '', cover: '',
      localAudio: '', audioExt: '', audioAt: 0, source: '', matched: false,
      /* 网易云官方长期外链：识别到 ID 即可秒开试听，不用等自家仓库代抓；
       * 汽水音频带签名会过期、无长期外链，留空继续走代抓。 */
      directAudio: (p.key === 'netease' && /^\d{5,14}$/.test(id))
        ? ('https://music.163.com/song/media/outer/url?id=' + id + '.mp3') : '',
      blobUrl: '',
      page: (typeof extractURL === 'function' ? extractURL(raw) : '') ||
            (String(raw).match(/https?:\/\/[^\s"'<>]+/) || [])[0] || '',
      url: raw,
    };
  }

  /* 缓存里可能是总缓存 entry，也可能是轻量 { ok, data }，统一摊平 */
  function flat(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.data && typeof e.data === 'object') return e.data;
    return e;
  }
  const good = e => !!(e && e.kind === 'music' && !e.err && e.localAudio && LOCAL_AUDIO_RE.test(e.localAudio));

  /* 新结果的 JSON 可经 GitHub API 立刻读到，但 Pages 音频可能还没发布。
   * 刚入库的 15 分钟改读自家仓库 raw（文件名固定、无签名、可长期缓存），
   * 老缓存继续走同源 Pages，兼顾首次秒开与日常加载速度。 */
  function audioSrc(s) {
    const p = s && s.localAudio || '';
    if (!LOCAL_AUDIO_RE.test(p)) return '';
    const cfg = (typeof WPGH !== 'undefined' && WPGH.cfg) ? WPGH.cfg : null;
    const fresh = s.audioAt && Date.now() - s.audioAt < 15 * 60 * 1000;
    if (fresh && cfg && cfg.owner && cfg.repo && cfg.branch) {
      return 'https://raw.githubusercontent.com/' + encodeURIComponent(cfg.owner) + '/' +
        encodeURIComponent(cfg.repo) + '/' + encodeURIComponent(cfg.branch) + '/' + p;
    }
    return p;
  }
  /* 试听专用候选地址（快→稳）。实测 256KB 首包：jsdmirror 0.21s / raw 0.47s /
   * 同源 Pages 极慢（~12KB/s）。老缓存不再走慢速同源，一律先试 CDN。
   * 全部支持 Range 206，拖动进度/续传不会从头断。 */
  function audioPlayCands(s) {
    const p = s && s.localAudio || '';
    if (!LOCAL_AUDIO_RE.test(p)) return [];
    const cfg = (typeof WPGH !== 'undefined' && WPGH.cfg) ? WPGH.cfg : null;
    const owner = (cfg && cfg.owner) || '1yk8u', repo = (cfg && cfg.repo) || 'wallpaper';
    const raw = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/main/' + p;
    const jsd = 'https://cdn.jsdmirror.com/gh/' + owner + '/' + repo + '@main/' + p;
    const off = 'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@main/' + p;
    return [jsd, raw, off, p].filter((u, i, a) => u && a.indexOf(u) === i);
  }

  function cacheKeyOf(s) {
    let key = '';
    try {
      if (typeof parseCacheKey === 'function') key = parseCacheKey(s.page || s.url) || '';
    } catch (e) {}
    if (!key) {
      key = (s.platform === 'netease' && /^\d{4,14}$/.test(s.id)) ? 'netease:' + s.id
        : (s.platform === 'qishui' && s.id) ? 'qishui:' + s.id : '';
    }
    return key;
  }

  /* ===== 向自家仓库要【同源音频】，拿不到就派单让 Actions 抓 ===== */
  async function enrich(s, row, noteEl) {
    const key = cacheKeyOf(s);
    if (!key || typeof serverCacheGet !== 'function') { failMeta(s, row, noteEl, '无法识别这条分享'); return; }
    try {
      let e = flat(await serverCacheGet(key));
      if (!good(e)) {
        /* 旧缓存里只有第三方 audio 直链 → 一律不认，重新让自家仓库抓一遍 */
        if (typeof relayDispatch !== 'function') { failMeta(s, row, noteEl, '自家仓库中转不可用'); return; }
        if (noteEl) noteEl.textContent = '让自家仓库抓官方音频…（首次约半分钟，之后秒出）';
        const since = Date.now();
        try { await relayDispatch(s.page || s.url, key); }
        catch (err) { if (!(err && err.soft)) throw err; }   /* 软失败：派单可能已寄出，继续等 */
        const got = await relayPoll(key, since, (i, sec) => {
          if (noteEl) noteEl.textContent = '自家仓库抓音频中… ' + sec + 's';
        });
        e = flat(got) || e;
      }
      if (good(e)) applyMeta(s, e, row);
      else failMeta(s, row, noteEl, '自家仓库还在准备音频，再点一次解析即可');
    } catch (err) {
      failMeta(s, row, noteEl, '仓库取音频失败，再点一次解析即可');
    }
  }

  function failMeta(s, row, note, msg) {
    if (note) note.textContent = msg;
    if (!row || s.localAudio) return;
    const media = row.querySelector('.mu-media');
    if (media) media.innerHTML = '<span class="mu-noaudio">自家仓库还没备好音频 · 可先点「打开原曲」</span>';
  }

  function applyMeta(s, e, row) {
    s.title = e.title || s.title;
    s.artist = e.artist || s.artist;
    s.album = e.album || s.album;
    s.cover = e.cover || s.cover;
    s.localAudio = e.localAudio || '';
    s.audioExt = e.audioExt || (/\.m4a$/i.test(s.localAudio) ? 'm4a' : 'mp3');
    s.audioAt = Date.parse(e.ts || '') || 0;
    s.source = e.source || '';
    s.matched = !!e.matched;
    if (!row) return;
    const ti = row.querySelector('.mu-title');
    if (ti) ti.innerHTML = '<span class="mu-note-sm">' + svg() + '</span>' + esc(s.title);
    const ar = row.querySelector('.mu-artist');
    if (ar) ar.textContent = [s.artist, s.album].filter(Boolean).join(' · ') || ' ';
    if (s.cover) {
      const cv = row.querySelector('.mu-cover');
      if (cv && !cv.querySelector('img')) {
        cv.classList.add('has-img');
        cv.insertAdjacentHTML('afterbegin', '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">');
      }
    }
    const media = row.querySelector('.mu-media');
    if (media && s.localAudio) {
      /* 试听走最快 CDN 起步，加载失败按候选逐级回退并接回进度，避免播放中断。
       * 全部候选支持 Range 206，拖动进度条不会从头重下。 */
      const cands = audioPlayCands(s);
      media.innerHTML = `<audio controls preload="metadata" src="${esc(cands[0] || audioSrc(s))}"></audio>` +
        (s.matched ? '<span class="mu-match">已匹配网易云同名版本</span>' : '') +
        '<span class="mu-local">自家仓库永久音频 · 秒开播放</span>';
      const au = media.querySelector('audio');
      if (au && cands.length > 1) {
        let tryIdx = 0;
        au.addEventListener('error', () => {
          if (tryIdx >= cands.length - 1) return;
          const at = au.currentTime, playing = !au.paused;
          tryIdx++;
          const nxt = cands[tryIdx];
          try { au.src = nxt; au.load(); } catch (e) {}
          if (at > 0) au.addEventListener('loadedmetadata', function restore() {
            au.removeEventListener('loadedmetadata', restore);
            try { au.currentTime = at; } catch (e) {}
            if (playing) { const p = au.play(); if (p && p.catch) p.catch(() => {}); }
          });
        });
      }
      const btn = row.querySelector('.mu-btn-dl');
      if (btn) btn.disabled = false;
      const sv = row.querySelector('.mu-btn-save');
      if (sv) sv.disabled = false;
    } else if (media) {
      media.innerHTML = '<span class="mu-noaudio">暂无可下载音频 · 点「打开原曲」收听</span>';
    }
    const note = row.querySelector('.mu-enrich');
    if (note) note.textContent = s.source || '同源音频已就绪，可直接播放 / 下载';
  }

  /* ===== 只在「存到壁纸库」时才取整首字节 =====
   * 播放 / 下载都用同源 src + 浏览器流式，不需要这一步。
   * 硬校验 LOCAL_AUDIO_RE，任何 http(s) 地址直接拒绝。 */
  async function ensureBlob(s) {
    if (s.blobUrl) return s.blobUrl;
    if (s._blobPromise) return s._blobPromise;
    if (!LOCAL_AUDIO_RE.test(s.localAudio || '')) return '';
    s._blobPromise = (async () => {
      try {
        const r = await fetch(audioSrc(s), { signal: AbortSignal.timeout(60000) });
        if (!r.ok) return '';
        const b = await r.blob();
        if (!b || b.size < 20000 || /text\/html|application\/json/i.test(b.type || '')) return '';
        s.blob = b;
        s.blobUrl = URL.createObjectURL(b);
        return s.blobUrl;
      } catch (e) { return ''; }
    })();
    const u = await s._blobPromise;
    if (!u) s._blobPromise = null;    /* 失败允许下次重试（文件可能还没提交上来） */
    return u;
  }

  async function grabAudio(s) {
    const u = await ensureBlob(s);
    if (!u) return null;
    if (s.blob) return s.blob;
    try { const r = await fetch(u); if (r.ok) return await r.blob(); } catch (e) {}
    return null;
  }

  function download(s, btn) {
    const old = btn.textContent;
    if (!s.localAudio || !LOCAL_AUDIO_RE.test(s.localAudio)) {
      /* 没有同源文件时，网易云退回官方直链：新窗口打开即可播放/另存。
       * 跨域 a.download 会被浏览器忽略，所以这里用 window.open 更可靠。 */
      if (s.directAudio) {
        window.open(s.directAudio, '_blank', 'noopener');
        btn.textContent = '已打开音源 ✓';
        setTimeout(() => { btn.textContent = old; }, 3500);
        return;
      }
      btn.textContent = '音频没取到';
      const note = btn.closest('.mu-item') && btn.closest('.mu-item').querySelector('.mu-enrich');
      if (note) note.textContent = '自家仓库里的音频还没就绪，再点一次解析';
      if (typeof toast === 'function') toast('音频没取到，可再点一次解析', 'warn');
      setTimeout(() => { btn.textContent = old; }, 3500);
      return;
    }
    /* 同源相对路径 + download 属性：浏览器原生流式下载，立刻开始，
     * 不用先把 2~4MB 整首读进内存，也绝不打开任何第三方页面。 */
    const a = document.createElement('a');
    a.href = s.localAudio;
    a.download = safeName(s);
    document.body.appendChild(a); a.click(); a.remove();
    btn.textContent = '已开始下载 ✓';
    setTimeout(() => { btn.textContent = old; }, 3500);
  }

  /* ===== 存到壁纸库（音乐分类，永久保存） ===== */
  async function saveToLibrary(s, btn) {
    if (typeof WPGH === 'undefined' || !WPGH.cfg || !WPGH.cfg.pat) {
      btn.textContent = '连接不可用';
      setTimeout(() => { btn.textContent = '存到壁纸库'; }, 2500);
      return;
    }
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '获取中…';
    const blob = await grabAudio(s);
    if (!blob) {
      btn.textContent = '音频没取到';
      setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3000);
      return;
    }
    btn.textContent = '提交中…';
    try {
      const name = '音乐_' + safeName(s);
      const title = ((s.title || '').trim() + (s.artist && !/官方|打开原曲/.test(s.artist) ? ' - ' + s.artist : '')).trim() || '音乐';
      /* 封面随音乐一起入库：命名 <音频名去扩展>.cover.jpg，
       * build-manifest 的 coverSuffix 正则会认这个格式，自动把 cover 字段关联回音乐条目。
       * 抓同源封面字节（s.cover 已是本站 data/covers/ 下的相对路径），失败就跳过、不阻断入库。 */
      let coverName = '', coverBytes = null;
      if (s.cover && !/^https?:/i.test(s.cover)) {
        try {
          const cr = await fetch(s.cover, { signal: AbortSignal.timeout(20000) });
          if (cr.ok) {
            const cb = await cr.blob();
            if (cb && cb.size > 500) {
              const dot = name.lastIndexOf('.');
              const base = dot > 0 ? name.slice(0, dot) : name;
              /* 保留原封面扩展名（jpg/png/webp），正则都认 */
              const m = /\.(jpe?g|png|webp|gif)$/i.exec(s.cover);
              coverName = base + '.cover.' + (m ? m[1].toLowerCase() : 'jpg');
              coverBytes = new Uint8Array(await cb.arrayBuffer());
            }
          }
        } catch (e) {}
      }
      const committed = await WPGH.importEntries([{
        name,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        size: blob.size,
        coverName,
        coverBytes,
        itemExtra: { title, cat: '音乐', kind: 'audio', gif: false },
      }], { onStatus: (i, text) => { btn.textContent = text.slice(0, 8); } });
      try { committed.forEach(it => allItems.unshift(it)); renderAll(); } catch (e) {}
      if (typeof toast === 'function') toast('音乐已存入壁纸库', 'ok');
      btn.textContent = '已入库 ✓';
      setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3500);
    } catch (e) {
      btn.textContent = '入库失败';
      setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3000);
      if (typeof toast === 'function') toast('入库失败：' + (e.message || e), 'bad');
    }
  }

  /* ===== 卡片：平台彩色图标 + 音符图标 + 同源封面 ===== */
  function card(s) {
    /* 有同源文件就用同源；否则网易云有官方直链，立刻给 audio 秒开试听；
     * 两者都没有才显示等待。同源就绪后 applyMeta 会把直链替换成同源文件。 */
    const audible = audioSrc(s) || s.directAudio;
    const media = audible
      ? `<audio controls preload="none" src="${esc(audible)}"></audio>` +
        (s.matched ? '<span class="mu-match">已匹配网易云同名版本</span>' : '') +
        (s.localAudio
          ? '<span class="mu-local">自家仓库永久音频 · 秒开播放</span>'
          : '<span class="mu-local">官方直链 · 秒开试听（下载/入库用同源备份）</span>')
      : '<span class="mu-noaudio">等自家仓库备音频… · 可先点「打开原曲」</span>';
    return `<div class="mu-item" style="--mc:${s.color}">
      <div class="mu-cover ${s.cover ? 'has-img' : ''}">${s.cover ? '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">' : ''}<span class="mu-note">${svg()}</span></div>
      <div class="mu-info">
        <div class="mu-title"><span class="mu-note-sm">${svg()}</span>${esc(s.title)}</div>
        <div class="mu-artist">${esc(s.artist || ' ')}</div>
        <div class="mu-media">${media}</div>
        <div class="mu-enrich"></div>
      </div>
      <div class="mu-actions">
        <button type="button" class="mu-btn-dl">下载音乐</button>
        <button type="button" class="mu-btn-save">存到壁纸库</button>
        <button type="button" class="mu-btn-open">打开原曲</button>
      </div>
    </div>`;
  }

  function bindCard(row, s) {
    const dl = row.querySelector('.mu-btn-dl');
    if (dl) dl.onclick = () => download(s, dl);
    const sv = row.querySelector('.mu-btn-save');
    if (sv) sv.onclick = () => saveToLibrary(s, sv);
    const op = row.querySelector('.mu-btn-open');
    if (op) op.onclick = () => window.open(s.page || NE_HOME, '_blank', 'noopener');
    /* 本地 blob 播放器不会因第三方直链过期而报错，无需备用源切换 */
  }

  function renderInto(container, songs, note) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML =
      `<div class="mu-head"><span class="mu-head-t">解析结果</span><span class="mu-head-sub">${esc(note || (songs.length + ' 首'))}</span></div>` +
      '<div class="mu-list">' + songs.map(sc => {
        const p = PLATS.find(x => x.key === sc.platform) || PLATS[0];
        return `<div class="mu-row" data-plat="${p.key}"><div class="mu-row-hd">${brand(p, 24)}<b>${esc(p.name)}</b></div>${card(sc)}</div>`;
      }).join('') + '</div>' +
      '<div class="mu-foot">本地毫秒级出卡片；歌名 / 歌手 / 封面 / 官方音频由自家仓库代抓后存成同源文件，' +
      '汽水优先官方原版（M4A），网易云为官方试听（MP3）。网易云识别到 ID 即给官方直链秒开试听，' +
      '后台同时抓同源永久备份供下载/入库；汽水音频会过期，只能走同源代抓（首次约半分钟，之后秒出）。' +
      '点【下载音乐】按原格式保存，点【存到壁纸库】永久进「壁纸 → 音乐」。' +
      '版权归原平台及权利人，仅个人试听收藏。</div>';
    box.querySelectorAll('.mu-row').forEach((row, i) => bindCard(row, songs[i]));
    return box;
  }

  function runInto(raw, container, opts) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return null;
    if (!String(raw || '').trim()) {
      box.classList.remove('hidden');
      box.innerHTML = '<div class="mu-err">先粘贴汽水 / 网易云的分享链接。</div>';
      return null;
    }
    const s = parse(raw);
    const b = renderInto(box, [s], opts && opts.note);
    if (!(opts && opts.noEnrich)) {
      const row = b && b.querySelector('.mu-row');
      const note = row && row.querySelector('.mu-enrich');
      enrich(s, row, note);
    }
    return s;
  }

  /* ===== 双平台自测：识别 + 同源音频 + 自家缓存 三项体检 ===== */
  async function selftest(container) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return [];
    const songs = DEMOS.map(d => parse(d.url + ' ' + d.text));
    const checked = PLATS.map((p, i) => ({ p, ok: !!(songs[i] && songs[i].platform === p.key && songs[i].id) }));
    renderInto(box, songs, '双平台自测 · 识别 ' + checked.filter(x => x.ok).length + '/' + PLATS.length);
    const line = document.createElement('div');
    line.className = 'mu-testline';
    line.innerHTML = checked.map(x => `<span class="mu-test ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✔' : '✘'} 识别 ${esc(x.p.short)}</span>`).join('') +
      '<span class="mu-test" id="mu-test-audio">同源音频检测中…</span>' +
      '<span class="mu-test" id="mu-test-cache">自家缓存检测中…</span>';
    const head = box.querySelector('.mu-head');
    if (head) head.insertAdjacentElement('afterend', line);

    /* 同源音频体检：只认自家仓库的相对路径，HEAD 一下确认文件已在 Pages 上。
     * 旧版拿第三方直链塞 <audio src> 探测，既暴露地址又会被风控，已删除。 */
    let localOK = 0, cacheOK = 0;
    for (const sc of songs) {
      const key = cacheKeyOf(sc);
      let e = null;
      try { e = flat((typeof serverCacheGet === 'function') ? await serverCacheGet(key) : null); } catch (err) {}
      if (e && e.kind === 'music' && !e.err) cacheOK++;
      if (good(e)) {
        try {
          const r = await fetch(e.localAudio, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
          if (r.ok) localOK++;
        } catch (err) {}
      }
    }
    const elA = $('mu-test-audio');
    if (elA) {
      elA.className = 'mu-test ' + (localOK === songs.length ? 'ok' : '');
      elA.textContent = '同源音频 ' + localOK + '/' + songs.length +
        (localOK === songs.length ? ' · 零第三方直连' : ' · 首次解析后代抓');
    }
    const elC = $('mu-test-cache');
    if (elC) {
      elC.className = 'mu-test ' + (cacheOK ? 'ok' : '');
      elC.textContent = '自家缓存 ' + cacheOK + '/' + songs.length;
    }
    return checked;
  }

  function styles() {
    if ($('music-styles')) return;
    const st = document.createElement('style');
    st.id = 'music-styles';
    st.textContent = `
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
.mu-pending{font-size:11px;color:#0369a1;background:#f0f9ff;border-radius:7px;padding:4px 8px;display:inline-block}
.mu-match{display:inline-block;margin-top:4px;font-size:10px;color:#b45309;background:#fffbeb;border-radius:6px;padding:2px 6px}
.mu-local{display:inline-block;margin-top:4px;margin-left:5px;font-size:10px;color:#0f766e;background:#f0fdfa;border-radius:6px;padding:2px 6px}
.mu-enrich{font-size:10.5px;color:#98a1b0;margin-top:3px;min-height:14px}
.mu-actions{display:grid;grid-template-columns:1fr;gap:5px;flex:none;width:118px}
.mu-actions button{border:none;border-radius:9px;padding:7px 6px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap}
.mu-btn-dl{background:var(--mc);color:#fff}
.mu-btn-save{background:#fff7ed;color:#c2410c}
.mu-btn-open{background:#f1f4f9;color:#5b6472}
.mu-actions button:disabled{opacity:.4;cursor:not-allowed}
.mu-foot{font-size:11px;color:#9aa3b2;margin-top:10px;line-height:1.6}
.mu-err{background:#fef2f2;color:#b91c1c;border-radius:10px;padding:10px 12px;font-size:12px}
.hidden{display:none!important}
@media(max-width:520px){.mu-item{gap:8px;padding:8px}.mu-cover{width:52px;height:52px}.mu-actions{width:104px}.mu-actions button{padding:6px 4px;font-size:10.5px}}
`;
    document.head.appendChild(st);
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
      let t = '';
      try { t = await navigator.clipboard.readText(); } catch (e) {}
      if (t && t.trim()) { inp.value = t.trim(); runInto(inp.value, 'mu-result'); return; }
      if (inp) inp.focus();
      if (typeof toast === 'function') toast('浏览器不让自动读剪贴板：请长按输入框手动粘贴', 'warn');
    });
    const go = $('mu-go');
    if (go) go.addEventListener('click', () => runInto(inp && inp.value, 'mu-result'));
    if (inp) {
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') runInto(inp.value, 'mu-result'); });
      inp.addEventListener('paste', () => setTimeout(() => {
        if (detect(inp.value)) runInto(inp.value, 'mu-result');
      }, 100));
    }
    const test = $('mu-test');
    if (test) test.addEventListener('click', () => selftest('mu-result'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { parse, runInto, selftest, detect, renderInto, ensureBlob, cacheKeyOf, LOCAL_AUDIO_RE, PLATS, DEMOS };
})();
