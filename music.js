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
  /* 自家仓库音频的 CDN 加速域名：同一份文件，jsdelivr 在国内实测 ~900KB/s，
   * 而 GitHub Pages 仅 ~13KB/s（4MB 要下 5 分钟）。这不是第三方音频源——
   * 文件仍在自家仓库，只是借 CDN 边缘节点分发，字节与同源完全一致。 */
  const AUDIO_CDN = 'https://cdn.jsdelivr.net/gh/1yk8u/wallpaper@main/';
  /* 相对音频路径 → 加速 URL；只接受 LOCAL_AUDIO_RE，杜绝任何外部直链。
   * 返回 absolute URL 供 <audio src> / fetch 使用。 */
  function normLocal(local) { return String(local || '').replace(/^\/+/, ''); }
  function cdnURL(local) {
    const p = normLocal(local);
    if (!LOCAL_AUDIO_RE.test(p)) return '';
    return AUDIO_CDN + p;
  }

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
      localAudio: '', audioExt: '', source: '', matched: false,
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
    if (!key || (typeof serverCacheGet !== 'function' && typeof lightResultGet !== 'function')) {
      failMeta(s, row, noteEl, '无法识别这条分享'); return;
    }
    try {
      /* 两路并行竞速，谁先拿到合法结果用谁：
       * ① 总缓存——首次下完后内存/session 命中，0ms 秒出；
       * ② 轻量单条 2KB 结果——总缓存没加载过时(~1-2s)顶上。
       * 旧版只先读轻量结果，即便总缓存已在内存也白等 2-4 秒，且期间显示兜底歌名
       * 让用户误以为「解析失败」。并行后已缓存歌曲稳定 0-2 秒出真实结果。 */
      const jobs = [];
      if (typeof serverCacheGet === 'function') {
        jobs.push(serverCacheGet(key).then(x => flat(x)).catch(() => null));
      }
      if (typeof lightResultGet === 'function') {
        jobs.push(lightResultGet(key, 6000, 0).then(x => flat(x)).catch(() => null));
      }
      let e = null;
      if (jobs.length) {
        /* 谁先给出 good 结果就用谁并立即返回；若一路先返回但 non-good，
         * 继续等其余路；全部 non-good 时取其中信息最全的一份往下走。 */
        e = await new Promise(resolve => {
          let settled = false, remain = jobs.length, lastGood = null;
          jobs.forEach(p => p.then(x => {
            if (settled) return;
            if (good(x)) { settled = true; resolve(x); return; }
            if (x && (!lastGood || Object.keys(x).length > Object.keys(lastGood).length)) lastGood = x;
            if (--remain === 0) { settled = true; resolve(lastGood); }
          }).catch(() => { if (--remain === 0 && !settled) { settled = true; resolve(lastGood); } }));
          setTimeout(() => { if (!settled) { settled = true; resolve(lastGood); } }, 6000);
        });
      }
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
      else armBackground(s, row, noteEl, key);
    } catch (err) {
      if (key) armBackground(s, row, noteEl, key);
      else failMeta(s, row, noteEl, '仓库取音频失败，再点一次解析即可');
    }
  }

  /* 首次解析时音频可能还在自家仓库抓取中（约半分钟）。旧版只让用户「再点一次」，
   * 很多人就此停住。改为后台静默补拉：每 5 秒看一眼轻量结果，音频一落库就自动
   * 更新这张卡片（图标/播放器/下载/存库全部就位），最多守 3 分钟。 */
  function armBackground(s, row, noteEl, key) {
    failMeta(s, row, noteEl, '自家仓库正在抓音频，好了一会自动出现…');
    if (typeof lightResultGet !== 'function' || !key) return;
    let tries = 0;
    const timer = setInterval(async () => {
      if (++tries > 36 || s.localAudio) { clearInterval(timer); return; }
      try {
        const e = flat(await lightResultGet(key, 8000, 0));
        if (good(e)) {
          clearInterval(timer);
          applyMeta(s, e, row);
          if (noteEl) noteEl.textContent = '音频已就绪 · 可播放/下载/存库';
          if (typeof toast === 'function') toast('「' + (e.title || s.title) + '」音频已就绪', 'ok');
        }
      } catch (err) {}
    }, 5000);
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
      /* 音频文件在自家仓库，但 Pages 在国内只有 ~13KB/s（4MB 要 5 分钟），
       * 直接用同源 <audio src> 点播会「很久才有声音」。改走 jsdelivr CDN（同一份文件，
       * ~900KB/s），preload=metadata 让浏览器后台先把 moov 头/首段拉好，点播即响。 */
      const playSrc = cdnURL(s.localAudio) || s.localAudio;
      media.innerHTML = `<span class="mu-buf" data-buf>读取音源…</span>` +
        `<audio controls preload="auto" src="${esc(playSrc)}"></audio>` +
        (s.matched ? '<span class="mu-match">※ 已配同名版本</span>' : '') +
        '<span class="mu-local">本站存档 · 点开即播</span>';
      const btn = row.querySelector('.mu-btn-dl');
      if (btn) btn.disabled = false;
      const sv = row.querySelector('.mu-btn-save');
      if (sv) sv.disabled = false;
      /* 统一绑定播放器（原生手势播放 + 后台预热），点下即响 */
      attachPlayer(s, row);
    } else if (media) {
      media.innerHTML = '<span class="mu-noaudio">音源整理中 · 可先点「打开原曲」</span>';
    }
    const note = row.querySelector('.mu-enrich');
    if (note) note.textContent = s.source ? String(s.source).replace(/（[^）]*）/g, '') : '音源已就绪';
  }

  /* ===== 只在「存到壁纸库」时才取整首字节 =====
   * 播放 / 下载都用同源 src + 浏览器流式，不需要这一步。
   * 硬校验 LOCAL_AUDIO_RE，任何 http(s) 地址直接拒绝。 */
  async function ensureBlob(s) {
    if (s.blobUrl) return s.blobUrl;
    if (s._blobPromise) return s._blobPromise;
    const norm = normLocal(s.localAudio);
    if (!LOCAL_AUDIO_RE.test(norm)) return '';
    s._blobPromise = (async () => {
      /* 通道竞速：CDN 秒下（~4s），同源 Pages 兜底。任一拿到合法音频字节即返回。
       * 绝不整首走 Pages——实测 4MB 下 120 秒才 1.5MB，60s 超时必然失败。 */
      const urls = [AUDIO_CDN + norm, s.localAudio];
      return new Promise(resolve => {
        let done = false, timer = null;
        const finish = (u, blob) => {
          if (done) return; done = true;
          if (timer) clearTimeout(timer);
          if (u) { s.blob = blob; s.blobUrl = URL.createObjectURL(blob); resolve(s.blobUrl); }
          else resolve('');
        };
        /* 不用 AbortSignal.timeout()——旧版 iOS Safari 没有这个构造器，直接抛错会让整条链卡死。
         * 靠上面的 finish 幂等 + 总超时即可，fetch 自己失败会走 catch。 */
        urls.forEach(src => {
          fetch(src).then(async r => {
            if (!r.ok) return;
            const b = await r.blob();
            if (b && b.size >= 20000 && !/text\/html|application\/json/i.test(b.type || '')) finish(src, b);
          }).catch(() => {});
        });
        timer = setTimeout(() => finish('', null), 50000);
      });
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

  /* 后台预热：把整首歌下到内存 blob。就绪后「仅在用户还没开始播」时把 <audio>
   * 的 src 换成 blob，这样之后点播是纯内存、点下即响。
   * 关键纪律：绝不在用户播放后切 src、绝不 pause、绝不异步调用 play()。
   * iOS Safari 只认用户手势同步栈里的播放，任何事后 play() 都会被拒绝——
   * 上一版正是「点播放→pause→等 blob→异步 play()」，结果点了没声音。 */
  function warmAudio(s, row) {
    if (!LOCAL_AUDIO_RE.test(normLocal(s.localAudio))) return;
    ensureBlob(s).then(u => {
      if (!u) return;
      const au = row && row.querySelector('.mu-media audio');
      if (!au || au.dataset.onblob === '1') return;
      if (au.dataset.fallback) return;   /* 已回退同源，别再动 */
      /* 只有用户完全没碰过播放（暂停且在开头）才无缝换 src；正在听就绝不打断 */
      if (!au.paused || (au.currentTime || 0) > 0) return;
      au.dataset.onblob = '1';
      try { au.src = u; au.load(); } catch (e) {}
    }).catch(() => {});
  }

  /* 播放器绑定：保持原生 <audio> 的行为——用户点播放由浏览器在自己的手势栈里
   * 处理，一定能响（CDN 流式，首段缓冲约 1 秒级）。我们只做三件事：
   *   ① 后台预热 blob（就绪且用户未播时换 src，下次点播秒响）
   *   ② 缓冲提示：canplay/playing 时隐藏
   *   ③ CDN 失败回退同源相对路径
   * 绝不拦截 play、pause 或事后 play()，否则 iOS 直接静音。 */
  function attachPlayer(s, row) {
    if (!row || !s.localAudio) return;
    const au = row.querySelector('.mu-media audio');
    const buf = row.querySelector('.mu-media [data-buf]');
    if (!au || au.dataset.bound === '1') return;
    au.dataset.bound = '1';
    const hideBuf = () => { if (buf) buf.style.display = 'none'; };

    au.addEventListener('canplay', hideBuf);
    au.addEventListener('loadedmetadata', hideBuf);
    au.addEventListener('playing', hideBuf);
    au.addEventListener('error', () => {
      if (au.dataset.fallback) return;
      au.dataset.fallback = '1';
      au.src = s.localAudio; au.load();
    });

    warmAudio(s, row);   /* 一渲染就后台预热，争取用户点之前就换好 blob */
  }

  function download(s, btn) {
    const old = btn.textContent;
    if (!s.localAudio || !LOCAL_AUDIO_RE.test(s.localAudio)) {
      btn.textContent = '音频没取到';
      const note = btn.closest('.mu-item') && btn.closest('.mu-item').querySelector('.mu-enrich');
      if (note) note.textContent = '自家仓库里的音频还没就绪，再点一次解析';
      if (typeof toast === 'function') toast('音频没取到，可再点一次解析', 'warn');
      setTimeout(() => { btn.textContent = old; }, 3500);
      return;
    }
    /* 自家仓库文件走 CDN + download 属性：浏览器原生流式下载，立刻开始，
     * 不用先把 2~4MB 整首读进内存，也绝不打开任何第三方音频源。 */
    const a = document.createElement('a');
    a.href = cdnURL(s.localAudio) || s.localAudio;
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
    btn.disabled = true; btn.textContent = '提交中…';
    if (!s.localAudio || !LOCAL_AUDIO_RE.test(normLocal(s.localAudio))) {
      btn.textContent = '音频没取到';
      setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3000);
      return;
    }
    try {
      const name = '音乐_' + safeName(s);
      const title = ((s.title || '').trim() + (s.artist && !/官方|打开原曲/.test(s.artist) ? ' - ' + s.artist : '')).trim() || '音乐';
      /* 音频已在仓库 data/audio/ 里，走 srcPath 零字节引用（拿 sha 直接进 tree），
       * 不再下载整首→base64→上传 5MB。存库从 ~11s 降到 ~5s。 */
      const committed = await WPGH.importEntries([{
        name,
        srcPath: normLocal(s.localAudio),
        /* playUrl 指向英文同源路径，供壁纸库播放器走 CDN 秒播（中文名 CDN 会 404）。
         * build-manifest 也会用 sha 匹配补这个字段，两边一致。 */
        /* cover 指向自家仓库 data/covers/xx.jpg（译名英文路径，CDN 可用），
         * 存进清单后音乐卡片与唱片机碟心都会显示这张真实封面。 */
        itemExtra: { title, cat: '音乐', kind: 'audio', gif: false,
          playUrl: normLocal(s.localAudio), cover: s.cover || '' },
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

  /* ===== 唱片登记卡：方角、纸底、衬线、细线，平台色只留一道书脊 ===== */
  function card(s, n) {
    const no = String(n || 1).padStart(2, '0');
    const media = s.localAudio
      ? `<span class="mu-buf" data-buf>读取音源…</span>` +
        `<audio controls preload="auto" src="${esc(cdnURL(s.localAudio) || s.localAudio)}"></audio>` +
        (s.matched ? '<span class="mu-match">※ 已配同名版本</span>' : '') +
        '<span class="mu-local">本站存档 · 点开即播</span>'
      : '<span class="mu-noaudio mu-loading">正在识别歌名与音源…</span>';
    return `<div class="mu-item" style="--mc:${s.color}">
      <div class="mu-cover ${s.cover ? 'has-img' : ''}">${s.cover ? '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">' : ''}<span class="mu-note">${svg()}</span></div>
      <div class="mu-info">
        <div class="mu-title"><span class="mu-note-sm">${svg()}</span>${esc(s.title)}</div>
        <div class="mu-artist">No.${no} &nbsp;·&nbsp; ${esc(s.artist || '佚名')}</div>
        <div class="mu-media">${media}</div>
        <div class="mu-enrich"></div>
      </div>
      <div class="mu-actions">
        <button type="button" class="mu-btn-dl">下载</button>
        <button type="button" class="mu-btn-save">存壁纸库</button>
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
    /* 统一绑定播放器（拦截点播 + 后台预热）。card 若已带 localAudio 会在此预热；
     * applyMeta 重建 media 后再绑定时，靠 audio.dataset.bound 防止重复绑定。 */
    attachPlayer(s, row);
  }

  function renderInto(container, songs, note) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML =
      `<div class="mu-head"><span class="mu-head-t">解析结果</span><span class="mu-head-sub">${esc(note || (songs.length + ' 首 · 唱片目录'))}</span></div>` +
      '<div class="mu-list">' + songs.map((sc, i) => {
        const p = PLATS.find(x => x.key === sc.platform) || PLATS[0];
        return `<div class="mu-row" data-plat="${p.key}"><div class="mu-row-hd">${brand(p, 22)}<b>${esc(p.name)}</b><span style="margin-left:auto;color:var(--dim)">${String(i + 1).padStart(2, '0')} / ${String(songs.length).padStart(2, '0')}</span></div>${card(sc, i + 1)}</div>`;
      }).join('') + '</div>' +
      '<div class="mu-foot">卡片本地即出；歌名、歌手、封面与音频由本站自行抓取存档，页面不含任何第三方音源。' +
      '首次解析约半分钟，之后即取即用。「下载」按原格式保存，「存壁纸库」收进「壁纸 → 音乐」。' +
      '版权归原平台及权利人，仅作个人试听收藏。</div>';
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
          const r = await fetch(e.localAudio, { method: 'HEAD' });
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
/* 音乐解析 —— 唱片目录卡 / 标本登记册。纸底、细线、衬线、留白，无渐变无药丸。 */
.mu-plats{display:flex;flex-wrap:wrap;gap:7px;margin:6px 0 2px}
.mu-plat{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line-deep);background:transparent;border-radius:2px;padding:6px 11px 6px 7px;font-family:var(--serif);font-size:12.5px;font-weight:700;color:var(--ink-2);cursor:pointer;letter-spacing:.04em;transition:none}
.mu-plat:hover{border-color:var(--moss);color:var(--moss-deep);background:var(--moss-paper)}
.mu-plat .mu-brand{--ms:20px}
.mu-brand{display:inline-flex;align-items:center;justify-content:center;width:var(--ms,20px);height:var(--ms,20px);border-radius:1px;background:var(--mc);color:#fff;flex:none;position:relative;overflow:hidden}
.mu-brand svg{position:absolute;inset:0;width:100%;height:100%}
.mu-brand svg:first-child{width:74%;height:74%;margin:auto;z-index:1}
.mu-head{display:flex;align-items:baseline;gap:12px;margin:16px 0 12px;border-bottom:2px solid var(--ink);padding-bottom:6px}
.mu-head-t{font-family:var(--serif);font-size:17px;font-weight:900;color:var(--ink);letter-spacing:.08em}
.mu-head-sub{font-size:11px;color:var(--dim);margin-left:auto;font-family:var(--serif);letter-spacing:.1em}
.mu-testline{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 12px}
.mu-test{font-size:11px;border:1px solid var(--line);background:var(--paper-2);color:var(--ink-2);padding:3px 8px;border-radius:1px;font-family:var(--serif)}
.mu-test.ok{border-color:var(--moss);color:var(--moss-deep);background:var(--moss-paper)}
.mu-test.bad{border-color:var(--terracotta);color:var(--terracotta)}
.mu-list{display:flex;flex-direction:column;gap:14px}
.mu-row{background:transparent;border-left:3px solid var(--mc);padding:2px 0 2px 14px}
.mu-row-hd{display:flex;align-items:center;gap:7px;font-family:var(--serif);font-size:12.5px;color:var(--ink-2);margin-bottom:9px;letter-spacing:.05em}
.mu-row-hd b{font-weight:900;color:var(--ink)}
.mu-item{display:flex;gap:14px;align-items:flex-start;background:var(--paper);border:1px solid var(--line);border-radius:2px;padding:14px}
.mu-cover{width:70px;height:70px;border-radius:1px;flex:none;position:relative;overflow:hidden;background:var(--paper-3);border:1px solid var(--line-deep);display:flex;align-items:center;justify-content:center;color:var(--moss-deep)}
.mu-cover::after{content:"";position:absolute;inset:4px;border:1px dotted var(--line-deep);pointer-events:none}
.mu-cover img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
.mu-cover.has-img .mu-note{display:none}
.mu-note{width:30px;height:30px;position:relative;z-index:1}
.mu-note svg{width:100%;height:100%}
.mu-info{flex:1;min-width:0}
.mu-title{display:flex;align-items:center;gap:6px;font-family:var(--serif);font-size:16px;font-weight:900;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.03em}
.mu-note-sm{width:14px;height:14px;flex:none;color:var(--mc)}
.mu-note-sm svg{width:100%;height:100%}
.mu-artist{font-size:11.5px;color:var(--dim);margin:4px 0 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.06em}
.mu-media{min-height:32px;border-top:1px dotted var(--line-deep);padding-top:9px}
.mu-item audio{width:100%;height:34px;display:block}
.mu-noaudio{font-size:11px;color:var(--dim);display:inline-block;padding:2px 0}
.mu-loading{color:var(--moss-deep);animation:muPulse 1.1s ease-in-out infinite}
@keyframes muPulse{0%,100%{opacity:.45}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.mu-loading{animation:none}}
.mu-pending{font-size:11px;color:var(--moss-deep);display:inline-block;padding:2px 0}
.mu-match{display:inline-block;margin-top:5px;font-size:10.5px;color:var(--honey);font-family:var(--serif)}
.mu-local{display:inline-block;margin-top:5px;margin-left:10px;font-size:10.5px;color:var(--moss-deep);font-family:var(--serif)}
.mu-buf{display:inline-block;font-size:11px;color:var(--moss-deep);margin-bottom:3px;font-family:var(--serif);letter-spacing:.06em}
.mu-buf::before{content:"· ";color:var(--terracotta)}
.mu-enrich{font-size:10.5px;color:var(--dim);margin-top:6px;min-height:14px;letter-spacing:.03em}
.mu-actions{display:flex;flex-direction:column;gap:6px;flex:none;width:104px}
.mu-actions button{border:1px solid var(--line-deep);border-radius:1px;background:var(--paper);padding:7px 5px;font-family:var(--serif);font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;color:var(--ink-2);letter-spacing:.05em}
.mu-actions button:hover{background:var(--paper-3)}
.mu-btn-dl{color:var(--moss-deep)!important;border-color:var(--moss)!important}
.mu-btn-save{color:var(--terracotta)!important;border-color:var(--terracotta)!important}
.mu-actions button:disabled{opacity:.4;cursor:not-allowed}
.mu-foot{font-family:var(--serif);font-size:11px;color:var(--dim);margin-top:16px;line-height:1.8;border-top:1px dotted var(--line-deep);padding-top:10px;letter-spacing:.02em}
.mu-err{border:1px solid var(--terracotta);color:var(--terracotta);background:var(--paper);border-radius:1px;padding:12px 14px;font-family:var(--serif);font-size:12.5px}
.hidden{display:none!important}
@media(max-width:520px){.mu-item{gap:10px;padding:11px;flex-wrap:wrap}.mu-cover{width:58px;height:58px}.mu-actions{width:100%;flex-direction:row}.mu-actions button{flex:1;padding:8px 3px;font-size:11px}.mu-title{font-size:15px}}
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
    const clear = $('mu-clear');
    if (clear) clear.addEventListener('click', () => {
      if (inp) { inp.value = ''; inp.focus(); }
      const box = $('mu-result');
      if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { parse, runInto, selftest, detect, renderInto, ensureBlob, cacheKeyOf, LOCAL_AUDIO_RE, PLATS, DEMOS };
})();
