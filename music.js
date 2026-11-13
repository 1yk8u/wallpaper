/* =====================================================================
 * music.js —— 自研音乐解析工具（纯前端，零后端、零等待）
 *
 * 支持：汽水音乐 / 网易云音乐 / QQ音乐 / 酷狗音乐 分享链接
 * 输出：平台彩色图标 + 每首歌音符图标 + 歌名 / 歌手 / 封面 /
 *       播放器(网易云) + 下载 + 打开原曲
 * 手机在国内、GitHub Pages 无服务端、公共 CORS 代理不稳，
 * 因此「本地识别立刻出卡片 → 再异步尽力补元数据」，永不转圈等待。
 * ===================================================================== */
'use strict';

const Music = (() => {
  const NOTE = '<path d="M9 17.5V6.4l9-2V15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.4" cy="17.6" r="2.6" fill="currentColor"/><circle cx="15.4" cy="15.6" r="2.6" fill="currentColor"/>';
  const svg = (cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${NOTE}</svg>`;

  const PLATS = [
    { key: 'netease', name: '网易云音乐', short: '网易云', color: '#e60026',
      test: /(?:music\.)?163\.com|163cn\.tv/i,
      glyph: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".5"/>',
      idRe: /(?:song[/=]|\bid=|songId=)(\d{5,14})/i,
      page: id => 'https://music.163.com/#/song?id=' + id,
      audio: id => 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3' },
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

  /* 四平台自测样例（真实 ID / mid / hash；汽水用链接模板验证识别） */
  const DEMOS = [
    { key: 'netease', url: 'https://music.163.com/song?id=33894312', text: '分享《情非得已》给你 - 群星' },
    { key: 'qq',      url: 'https://y.qq.com/n/ryqq/songDetail/001yS0N33yPm1B', text: 'QQ音乐 分享《海阔天空》- Beyond' },
    { key: 'kugou',   url: 'https://www.kugou.com/song/#hash=EFEC0563692CAF94C184248B1D83227F', text: '酷狗音乐《海阔天空》- Beyond' },
    { key: 'qishui',  url: 'https://qishui.douyin.com/song/7351234567890123456', text: '汽水音乐 分享《起风了》给你' },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      audio: (p.key === 'netease' && id) ? p.audio(id) : '',
      page: url || home,
      url: url || '',
    };
    if (id && p.key !== 'qishui') s.page = p.page(id);
    return s;
  }

  function card(s) {
    return `<div class="mu-item" style="--mc:${s.color}">
      <div class="mu-cover ${s.cover ? 'has-img' : ''}">${s.cover ? '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">' : ''}<span class="mu-note">${svg('')}</span></div>
      <div class="mu-info">
        <div class="mu-title"><span class="mu-note-sm">${svg('')}</span>${esc(s.title)}</div>
        <div class="mu-artist">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}</div>
        ${s.audio
          ? `<audio controls preload="none" referrerpolicy="no-referrer" src="${esc(s.audio)}"></audio>`
          : '<span class="mu-noaudio">该平台未开放直链 · 点「打开原曲」收听</span>'}
      </div>
      <div class="mu-actions">
        <button type="button" class="mu-btn-dl" ${s.audio ? '' : 'disabled'}>下载</button>
        <button type="button" class="mu-btn-open">打开原曲</button>
      </div>
    </div>`;
  }

  function bindCard(row, s) {
    const dl = row.querySelector('.mu-btn-dl');
    if (dl && s.audio) dl.addEventListener('click', () => {
      const name = (String(s.title || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)) + '.mp3';
      if (typeof downloadSmart === 'function') downloadSmart(s.audio, name);
      else window.open(s.audio, '_blank', 'noopener');
    });
    const op = row.querySelector('.mu-btn-open');
    if (op) op.addEventListener('click', () => window.open(s.page || s.url, '_blank', 'noopener'));
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
      '<div class="mu-foot">歌曲版权归原平台及权利人所有，仅用于个人试听收藏。有公开直链的平台显示播放器，其余提供官方跳转。</div>';
    box.querySelectorAll('.mu-row').forEach((row, i) => bindCard(row, songs[i]));
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

  /* ===== 异步补元数据（能通就补，通不了不影响卡片） ===== */
  async function enrich(s, box) {
    try {
      let x = null;
      if (s.platform === 'netease' && s.id && typeof fetchJSONSmart === 'function') {
        const d = await Promise.race([
          fetchJSONSmart('https://music.163.com/api/song/detail?ids=%5B' + s.id + '%5D', { ms: 5000 }),
          new Promise(r => setTimeout(() => r(null), 5500)),
        ]);
        const q = d && d.songs && d.songs[0];
        if (q) x = { title: q.name, artist: (q.artists || []).map(a => a.name).join(' / '), cover: (q.album || {}).picUrl || '', album: (q.album || {}).name || '' };
      } else if (s.platform === 'kugou' && s.id) {
        const d = await jsonp('https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=' + s.id + '&platid=4&mid=1&album_id=0', 5000).catch(() => null);
        const q = d && d.data;
        if (q && q.song_name) x = { title: q.song_name, artist: q.author_name || '', album: q.album_name || '', cover: q.img || '', audio: (q.play_url || '').replace(/^http:/, 'https:') };
      }
      if (!x || !box) return;
      const row = box.querySelector('.mu-row[data-plat="' + s.platform + '"]');
      if (!row) return;
      Object.assign(s, x);
      const ti = row.querySelector('.mu-title');
      if (ti && x.title) ti.innerHTML = '<span class="mu-note-sm">' + svg('') + '</span>' + esc(x.title);
      const ar = row.querySelector('.mu-artist');
      if (ar) ar.textContent = [x.artist, x.album].filter(Boolean).join(' · ');
      if (x.cover) {
        const cv = row.querySelector('.mu-cover');
        if (cv) { cv.classList.add('has-img'); cv.insertAdjacentHTML('afterbegin', '<img src="' + esc(x.cover) + '" referrerpolicy="no-referrer" alt="">'); }
      }
      if (x.audio && !row.querySelector('audio')) {
        const h = row.querySelector('.mu-noaudio');
        if (h) h.outerHTML = '<audio controls preload="none" referrerpolicy="no-referrer" src="' + esc(x.audio) + '"></audio>';
        const b = row.querySelector('.mu-btn-dl');
        if (b) { const nb = b.cloneNode(true); nb.disabled = false; b.parentNode.replaceChild(nb, b); bindCard(row, s); }
      }
    } catch (e) { /* 静默 */ }
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
    if (!(opts && opts.noEnrich)) enrich(s, box);
    return s;
  }

  /* ===== 四平台自测 ===== */
  function selftest(container) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return [];
    const songs = DEMOS.map(d => parse(d.url + ' ' + d.text));
    const checked = PLATS.map((p, i) => ({ p, ok: !!(songs[i] && songs[i].platform === p.key) }));
    renderInto(box, songs, '四平台自测 · ' + checked.filter(x => x.ok).length + '/4 通过');
    const line = document.createElement('div');
    line.className = 'mu-testline';
    line.innerHTML = checked.map(x => `<span class="mu-test ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✔' : '✘'} ${esc(x.p.short)}</span>`).join('');
    const head = box.querySelector('.mu-head');
    if (head) head.insertAdjacentElement('afterend', line);
    songs.forEach(s => enrich(s, box));
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
.mu-test{font-size:11px;font-weight:700;border-radius:999px;padding:4px 9px}
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
.mu-item audio{width:100%;height:32px;display:block}
.mu-noaudio{font-size:11px;color:#98a1b0;background:#f5f7fb;border-radius:7px;padding:4px 8px;display:inline-block}
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

  return { parse, runInto, selftest, detect, renderInto, PLATS, DEMOS };
})();
