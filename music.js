/* =====================================================================
 * music.js —— 音乐分享链接解析（网易云 / QQ音乐 / 酷狗 / 汽水音乐）
 *
 * 在「解析」页粘贴分享链接 → 调后端函数 → 渲染成歌曲卡片
 * 平台有彩色品牌图标，每首歌都有音符图标 / 封面 / 播放器 / 下载
 * 图标全部内联 SVG，零外部请求，首屏不加载任何额外资源
 * ===================================================================== */
'use strict';

const Music = (() => {
  const NOTE = '<path d="M9 17.5V6.4l9-2V15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.4" cy="17.6" r="2.6" fill="currentColor"/><circle cx="15.4" cy="15.6" r="2.6" fill="currentColor"/>';
  const svg = (cls, extra = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${NOTE}${extra}</svg>`;

  const PLATS = [
    { key: 'netease', name: '网易云音乐', color: '#e60026', test: /(?:music\.)?163\.com|163cn\.tv|y\.music\.163\.com/i,
      glyph: '<circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/>' },
    { key: 'qq', name: 'QQ音乐', color: '#12b76a', test: /(?:c6?|i|y|qm)\.y\.qq\.com|y\.qq\.com|qq\.com\/music/i,
      glyph: '<path d="M4 12a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/>' },
    { key: 'kugou', name: '酷狗音乐', color: '#2f7bff', test: /kugou\.com|t1?\.kugou\.com|kugou\.com\.cn/i,
      glyph: '<path d="M5 19V5l7 7 7-7v14" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".5"/>' },
    { key: 'qishui', name: '汽水音乐', color: '#00c2c7', test: /qishui\.douyin\.com|music\.douyin\.com|qishui\.com/i,
      glyph: '<path d="M4 15c2-3 4-3 6 0s4 3 6 0 3-2 4-1" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/>' },
  ];
  const VIDEO_PLATS = [
    { name: '抖音', color: '#111827' }, { name: '快手', color: '#ff5a1f' },
    { name: 'B站', color: '#00a1d6' }, { name: '小红书', color: '#ff2442' },
  ];

  const API = '/.netlify/functions/music';

  function detect(url) {
    const u = String(url || '');
    return PLATS.find(p => p.test.test(u)) || null;
  }
  function isMusicLink(url) { return !!detect(String(url || '')); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function brandIcon(p, size) {
    return `<span class="mu-brand" style="--mc:${p.color};${size ? '--ms:' + size + 'px' : ''}">${svg('mu-brand-svg', p.glyph || '')}</span>`;
  }

  /* ===== 首页平台条 ===== */
  function renderStrip() {
    const box = document.getElementById('plat-strip');
    if (!box) return;
    const vids = VIDEO_PLATS.map(p =>
      `<span class="mu-chip"><i class="mu-dot" style="background:${p.color}"></i>${p.name}</span>`).join('');
    const mus = PLATS.map(p =>
      `<span class="mu-chip mu-chip-music" style="--mc:${p.color}">${brandIcon(p, 16)}<b>${p.name}</b></span>`).join('');
    box.innerHTML = `<span class="mu-strip-label">支持解析</span>${vids}<span class="mu-strip-sep"></span>${mus}<span class="mu-strip-tip">音乐链接直接出歌曲</span>`;
  }

  /* ===== 样式（只注入一次） ===== */
  function injectStyles() {
    if (document.getElementById('music-styles')) return;
    const s = document.createElement('style');
    s.id = 'music-styles';
    s.textContent = `
.mu-strip{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:2px 0 14px}
.mu-strip-label{font-size:11px;color:#8a94a6;font-weight:700;margin-right:2px}
.mu-strip-sep{width:1px;height:16px;background:#e3e7ee;margin:0 4px}
.mu-strip-tip{font-size:11px;color:#9aa3b2;margin-left:auto}
.mu-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#5b6472;background:#f4f6fa;border:1px solid #e9edf4;border-radius:999px;padding:3px 9px;white-space:nowrap}
.mu-chip b{font-weight:600}
.mu-chip-music{background:color-mix(in srgb,var(--mc) 9%,#fff);border-color:color-mix(in srgb,var(--mc) 24%,#fff);color:var(--mc)}
.mu-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.mu-brand{--ms:22px;width:var(--ms);height:var(--ms);display:inline-flex;align-items:center;justify-content:center;border-radius:7px;background:var(--mc);color:#fff;flex:none}
.mu-brand-svg{width:78%;height:78%}
.mu-head{display:flex;align-items:center;gap:10px;margin:4px 0 14px}
.mu-head .mu-brand{--ms:34px;border-radius:10px}
.mu-head-name{font-size:16px;font-weight:800;color:#1f2937}
.mu-head-sub{font-size:11px;color:#9aa3b2;margin-left:auto}
.mu-list{display:flex;flex-direction:column;gap:10px}
.mu-item{display:flex;gap:12px;align-items:center;background:#fff;border:1px solid #e8ecf3;border-radius:14px;padding:10px;box-shadow:0 2px 8px rgba(20,30,60,.04)}
.mu-cover{width:66px;height:66px;border-radius:10px;flex:none;position:relative;overflow:hidden;background:linear-gradient(135deg,#a5b4fc,#f0abfc);display:flex;align-items:center;justify-content:center;color:#fff}
.mu-cover img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
.mu-cover .mu-note{position:relative;width:30px;height:30px;opacity:.95}
.mu-cover.has-img .mu-note{display:none}
.mu-note svg{width:100%;height:100%}
.mu-info{flex:1;min-width:0}
.mu-title{display:flex;align-items:center;gap:5px;font-size:14px;font-weight:700;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mu-title .mu-note-sm{color:var(--mc,#6b7cff);width:14px;height:14px;flex:none}
.mu-title .mu-note-sm svg{width:100%;height:100%}
.mu-artist{font-size:12px;color:#8a94a6;margin:3px 0 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mu-item audio{width:100%;height:32px;display:block}
.mu-noaudio{font-size:11px;color:#b0b8c6;background:#f7f8fb;border-radius:7px;padding:5px 8px;display:inline-block}
.mu-actions{display:flex;flex-direction:column;gap:6px;flex:none}
.mu-actions button{border:none;border-radius:9px;padding:7px 11px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
.mu-btn-dl{background:var(--mc,#2563eb);color:#fff}
.mu-btn-open{background:#f1f4f9;color:#5b6472}
.mu-actions button:disabled{opacity:.45;cursor:not-allowed}
.mu-foot{font-size:11px;color:#9aa3b2;margin-top:12px;line-height:1.6}
@media(max-width:520px){.mu-item{gap:8px;padding:8px}.mu-cover{width:54px;height:54px}.mu-actions button{padding:6px 8px;font-size:11px}.mu-strip-tip{display:none}}
`;
    document.head.appendChild(s);
  }

  /* ===== 结果渲染 ===== */
  function render(d) {
    const box = document.getElementById('ex-result');
    if (!box) return;
    const p = PLATS.find(x => x.key === d.platform) || PLATS[0];
    const songs = (d.songs || []).filter(Boolean);
    if (!songs.length) throw new Error(d.error || '没有识别到歌曲，请确认分享链接是否完整');

    box.classList.remove('hidden');
    box.innerHTML =
      `<div class="mu-head">${brandIcon(p, 34)}<span class="mu-head-name">${esc(p.name)}</span>
        <span class="mu-head-sub">${esc(d.via || '分享链接解析')} · ${songs.length} 首</span></div>
       <div class="mu-list">` +
      songs.map((s, i) => {
        const cover = s.cover ? `<img src="${esc(s.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove();this.parentNode.classList.remove('has-img')">` : '';
        const audio = s.audio
          ? `<audio controls preload="none" referrerpolicy="no-referrer" src="${esc(s.audio)}"></audio>`
          : `<span class="mu-noaudio">该平台未开放直链，点「打开原曲」收听</span>`;
        return `<div class="mu-item" style="--mc:${p.color}" data-i="${i}">
          <div class="mu-cover ${s.cover ? 'has-img' : ''}">${cover}<span class="mu-note">${svg('')}</span></div>
          <div class="mu-info">
            <div class="mu-title"><span class="mu-note-sm">${svg('')}</span>${esc(s.title || '未知歌曲')}</div>
            <div class="mu-artist">${esc(s.artist || '未知歌手')}${s.album ? ' · ' + esc(s.album) : ''}</div>
            ${audio}
          </div>
          <div class="mu-actions">
            <button class="mu-btn-dl" data-dl="${i}" ${s.audio ? '' : 'disabled'}>下载</button>
            <button class="mu-btn-open" data-open="${i}">打开原曲</button>
          </div>
        </div>`;
      }).join('') +
      `</div><div class="mu-foot">歌曲版权归原平台及权利人所有，请仅用于个人试听收藏。受平台限制，部分歌曲仅提供跳转收听；能拿到直链的会显示播放器并可下载。</div>`;

    box.querySelectorAll('[data-dl]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = songs[+btn.dataset.dl];
        if (!s || !s.audio) return;
        if (typeof downloadSmart === 'function') {
          downloadSmart(s.audio, (String(s.title || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)) + '.mp3');
        } else window.open(s.audio, '_blank', 'noopener');
      });
    });
    box.querySelectorAll('[data-open]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = songs[+btn.dataset.open];
        const u = (s && (s.page || s.audio)) || d.finalUrl;
        if (u) window.open(u, '_blank', 'noopener');
      });
    });
  }

  /* ===== 本地识别（GitHub Pages / 无后端时的兜底，秒出卡片）===== */
  function guessFromText(t) {
    const s = String(t || '');
    const m = s.match(/《([^》]{1,60})》/);
    let title = m ? m[1] : '', artist = '';
    const dash = s.match(/《[^》]+》\s*[-—–]\s*([^\s,，。]{1,24})/);
    if (dash) artist = dash[1];
    if (!artist) {
      const a = s.match(/(?:分享|来自|歌手|演唱|artist)[：:\s]*([^\s,，。\-《》]{1,24})/);
      if (a) artist = a[1];
    }
    if (!title) {
      const t2 = s.match(/([^\s《》]{2,30})\s*[-—–]\s*([^\s《》,，。]{2,30})/);
      if (t2 && !/^https?/i.test(t2[1])) { title = t2[1]; artist = artist || t2[2]; }
    }
    return { title, artist };
  }

  function patchSong(s) {
    const box = document.getElementById('ex-result');
    if (!box) return;
    const it = box.querySelector('.mu-item');
    if (!it) return;
    const ti = it.querySelector('.mu-title');
    if (ti && s.title) ti.innerHTML = '<span class="mu-note-sm">' + svg('') + '</span>' + esc(s.title);
    const ar = it.querySelector('.mu-artist');
    if (ar && (s.artist || s.album)) ar.textContent = [s.artist, s.album].filter(Boolean).join(' · ');
    const cv = it.querySelector('.mu-cover');
    if (cv && s.cover) {
      cv.classList.add('has-img');
      cv.insertAdjacentHTML('afterbegin', '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">');
    }
    if (s.audio && !it.querySelector('audio')) {
      const holder = it.querySelector('.mu-noaudio');
      if (holder) holder.outerHTML = '<audio controls preload="none" referrerpolicy="no-referrer" src="' + esc(s.audio) + '"></audio>';
      const btn = it.querySelector('[data-dl]');
      if (btn) {
        const nb = btn.cloneNode(true);   // 清掉旧的空直链监听器
        nb.disabled = false;
        nb.onclick = () => { if (typeof downloadSmart === 'function') downloadSmart(s.audio, (s.title || 'song') + '.mp3'); };
        btn.parentNode.replaceChild(nb, btn);
      }
    }
  }

  async function runLocal(url, rawText) {
    const p = detect(url) || detect(rawText) || PLATS[0];
    const g = guessFromText(rawText);
    const song = { title: g.title, artist: g.artist, album: '', cover: '', audio: '', page: url };
    const src = url + ' ' + String(rawText || '');

    let id = '';
    if (p.key === 'netease') {
      const m = src.match(/(?:song[/=]|\bid=|songId=)(\d{5,14})/i);
      id = m ? m[1] : '';
      if (id) {
        song.page = 'https://music.163.com/#/song?id=' + id;
        song.audio = 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3';
      }
    } else if (p.key === 'qq') {
      const m = src.match(/(?:songDetail\/|songmid=|[?#&]mid=)([A-Za-z0-9]{10,20})/i);
      id = m ? m[1] : '';
      if (id) song.page = 'https://y.qq.com/n/ryqq/songDetail/' + id;
    } else if (p.key === 'kugou') {
      const m = src.match(/([0-9a-fA-F]{32})/);
      id = m ? m[1] : '';
      if (id) song.page = 'https://www.kugou.com/song/#hash=' + id;
    } else {
      const m = src.match(/(?:song\/|music_id=|\bid=)(\d{6,20})/i);
      id = m ? m[1] : '';
      song.page = url;
    }
    if (!song.title) song.title = (id ? p.name + ' · 歌曲 ' + id.slice(0, 12) : p.name + ' 分享歌曲');

    render({ platform: p.key, via: '本地识别', finalUrl: url, songs: [song] });
    if (window.setStatus) window.setStatus('已识别 ' + p.name + ' 歌曲 · 正在补全信息', 'ok');

    /* 后台尽力补元数据 / 直链（core.js 的代理通道），失败也不影响卡片 */
    try {
      let extra = null;
      if (p.key === 'netease' && id && typeof fetchJSONSmart === 'function') {
        const d = await Promise.race([
          fetchJSONSmart('https://music.163.com/api/song/detail?ids=%5B' + id + '%5D', { ms: 6000 }),
          new Promise(r => setTimeout(() => r(null), 7000)),
        ]);
        const s = d && d.songs && d.songs[0];
        if (s) extra = { title: s.name, artist: (s.artists || []).map(a => a.name).join(' / '), cover: (s.album || {}).picUrl || '' };
      } else if (p.key === 'kugou' && id && typeof fetchJSONSmart === 'function') {
        const d = await Promise.race([
          fetchJSONSmart('https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=' + id + '&platid=4&mid=1&album_id=0', { ms: 6000 }),
          new Promise(r => setTimeout(() => r(null), 7000)),
        ]);
        const s = d && d.data;
        if (s) extra = { title: s.song_name, artist: s.author_name, cover: s.img, album: s.album_name, audio: (s.play_url || '').replace(/^http:/, 'https:') };
      } else if (typeof fetchTextSmart === 'function') {
        const html = await Promise.race([
          fetchTextSmart(url, { ms: 6000 }),
          new Promise(r => setTimeout(() => r(''), 7000)),
        ]);
        const og = String(html || '').match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i);
        const im = String(html || '').match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)/i);
        if (og) {
          const t = guessFromText(og[1]);
          extra = { title: t.title || og[1].split(/\s*[-—–|]\s*/)[0], artist: t.artist, cover: im ? im[1] : '' };
        }
      }
      if (extra) patchSong(Object.assign({}, song, extra));
    } catch (e) { /* 补不到就算了，卡片已经可用 */ }
  }

  /* ===== 主流程：优先后端函数，不可用立刻退到本地识别（秒出，不转圈）===== */
  async function run(url) {
    injectStyles();
    const p = detect(url) || PLATS[0];
    const setStatus = window.setStatus;
    const statusEl = document.getElementById('ex-status');
    const rawText = (document.getElementById('link-input') || {}).value || url;
    if (setStatus) setStatus('<span class="spin"></span>正在解析 ' + p.name + ' 分享链接…', '');
    const box = document.getElementById('ex-result');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }

    let d = null, lastErr = '';
    try {
      const r = await fetch(API + '?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        const j = await r.json();
        if (j.songs && j.songs.length) d = j;
        else lastErr = j.error || '无歌曲';
      } else lastErr = 'HTTP ' + r.status;
    } catch (e) { lastErr = e.message || 'network'; }

    if (!d) return runLocal(url, rawText);

    if (setStatus) setStatus('解析成功 · ' + (d.songs ? d.songs.length : 0) + ' 首', 'ok');
    else if (statusEl) statusEl.classList.add('hidden');
    render(d);
  }

  function init() {
    injectStyles();
    renderStrip();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { isMusicLink, detect, run, runLocal, render, renderStrip, PLATS };
})();
