/* =====================================================================
 * music.js —— 自研音乐解析 v4（网易云 + 汽水音乐）
 *
 * 原则：零第三方服务。
 *   ① 本地识别：分享链接/口令 → 平台 + ID + 歌名（毫秒级出卡片）
 *   ② 播放/下载直链：网易云自家 outer 端点（music.163.com 自己的接口）
 *   ③ 元数据（歌名/歌手/封面）与汽水匹配：走自家仓库中转
 *      （repository_dispatch → GitHub Actions 调平台官方接口 → parse-cache）
 *   ④ 存入壁纸库：WPGH 仓库直连，永久保存进「音乐」分类
 * ===================================================================== */
'use strict';

const Music = (() => {
  const NOTE = '<path d="M9 17.5V6.4l9-2V15.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.4" cy="17.6" r="2.6" fill="currentColor"/><circle cx="15.4" cy="15.6" r="2.6" fill="currentColor"/>';
  const svg = () => `<svg viewBox="0 0 24 24" aria-hidden="true">${NOTE}</svg>`;
  const NE = 'https://music.163.com';

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
    { key: 'netease', url: 'https://music.163.com/song?id=186016', text: '分享《晴天》给你 - 周杰伦' },
    { key: 'qishui', url: 'https://music.douyin.com/qishui/share/track?track_id=7170454119939835942', text: '汽水音乐 分享《西海情歌》给你 - 刀郎' },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const outerURL = id => NE + '/song/media/outer/url?id=' + encodeURIComponent(id) + '.mp3';
  const safeName = s => (String(s.title || 'song') + (s.artist && !/官方|打开原曲/.test(s.artist) ? ' - ' + s.artist : ''))
    .replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.mp3';

  function detect(text) { return PLATS.find(p => p.test.test(String(text || ''))) || null; }
  function brand(p, size) {
    return `<span class="mu-brand" style="--mc:${p.color};--ms:${size || 22}px">${svg()}${p.glyph}</span>`;
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

  /* ===== 本地识别（毫秒级，无网络） ===== */
  function parse(raw) {
    const p = detect(raw) || PLATS[0];
    const m = String(raw || '').match(p.idRe);
    let id = m ? (m[1] || m[2] || '') : '';
    if (p.key === 'qishui' && id) id = id.toLowerCase();   /* 短码键统一小写（与中转一致） */
    const g = guessText(raw);
    const s = {
      platform: p.key, platformName: p.name, color: p.color, id,
      title: g.title || (id ? p.short + ' · 歌曲 ' + id.slice(0, 12) : p.name + ' 分享歌曲'),
      artist: g.artist || '',
      album: '', cover: '',
      audio: '', matched: false,
      page: (String(raw).match(/https?:\/\/[^\s"'<>]+/) || [])[0] || '',
      url: raw,
    };
    if (p.key === 'netease' && /^\d{4,14}$/.test(id)) s.audio = outerURL(id);
    return s;
  }

  /* ===== 与自家仓库对账：缓存有就补全，没有就寄单代抓 ===== */
  async function enrich(s, row, noteEl) {
    /* 键优先走 parseCacheKey（与 extractor/中转逐字节一致），兜底用平台:ID */
    let key = '';
    try {
      if (typeof parseCacheKey === 'function') key = parseCacheKey(s.page || s.url) || '';
    } catch (e) {}
    if (!key) {
      key = (s.platform === 'netease' && /^\d{4,14}$/.test(s.id)) ? 'netease:' + s.id
        : (s.platform === 'qishui' && s.id) ? 'qishui:' + s.id : '';
    }
    if (!key || typeof serverCacheGet !== 'function') return;
    try {
      let e = await serverCacheGet(key);
      const fresh = e && !e.err && e.kind === 'music';
      if (!fresh) {
        if (typeof relayDispatch !== 'function') return;
        if (noteEl) noteEl.textContent = '寄给自家仓库取元数据…';
        const since = Date.now();
        await relayDispatch(s.url, key);
        e = await relayPoll(key, since, (i, sec) => { if (noteEl) noteEl.textContent = '仓库取元数据… ' + sec + 's'; });
      }
      if (e && e.kind === 'music' && !e.err) applyMeta(s, e, row);
      else if (noteEl) noteEl.textContent = '元数据没取到，可点「打开原曲」';
    } catch (err) {
      if (noteEl) noteEl.textContent = '元数据获取失败（不影响本地已识别的信息）';
    }
  }

  function applyMeta(s, e, row) {
    s.title = e.title || s.title;
    s.artist = e.artist || s.artist;
    s.album = e.album || s.album;
    s.cover = e.cover || s.cover;
    if (e.audio) s.audio = e.audio;
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
    if (media && s.audio) {
      media.innerHTML = `<audio controls preload="none" src="${esc(s.audio)}"></audio>` +
        (s.matched ? '<span class="mu-match">汽水未开放直链 · 已匹配网易云同名版本</span>' : '');
      const btn = row.querySelector('.mu-btn-dl');
      if (btn) { btn.disabled = false; btn.onclick = () => download(s, btn); }
      const sv = row.querySelector('.mu-btn-save');
      if (sv) sv.disabled = false;
    } else if (media && !s.audio) {
      media.innerHTML = '<span class="mu-noaudio">没有可下载直链 · 点「打开原曲」收听</span>';
    }
    const note = row.querySelector('.mu-enrich');
    if (note) note.textContent = s.matched ? '元数据已就绪（汽水 → 网易云同名匹配）' : '元数据已就绪';
  }

  /* ===== 播放/下载：网易云自家 outer 端点直取 blob ===== */
  async function grabAudio(s) {
    if (s.blobUrl) {
      try { const r = await fetch(s.blobUrl); if (r.ok) return await r.blob(); } catch (e) {}
    }
    if (!s.audio) return null;
    try {
      const r = await fetch(s.audio, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return null;
      const b = await r.blob();
      if (b && b.size > 20000) {
        s.blobUrl = URL.createObjectURL(b);
        return b;
      }
    } catch (e) { /* 跨域/版权页 → 走打开原曲兜底 */ }
    return null;
  }

  async function download(s, btn) {
    if (!s.audio) { window.open(s.page || s.url, '_blank', 'noopener'); return; }
    const name = safeName(s);
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '获取中…';
    const blob = await grabAudio(s);
    if (blob) {
      const a = document.createElement('a');
      a.href = s.blobUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      btn.textContent = '已保存 ✓';
      const au = btn.closest('.mu-item') && btn.closest('.mu-item').querySelector('audio');
      if (au) { au.src = s.blobUrl; au.load(); }
    } else {
      /* 直链跨域取不到 blob：打开音频页，手机长按即可保存 */
      window.open(s.audio, '_blank', 'noopener');
      btn.textContent = '已打开 · 长按保存';
      if (typeof toast === 'function') toast('浏览器跨域取不到文件，已打开音频页：手机长按 → 存储', 'warn');
    }
    setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 3500);
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
      const committed = await WPGH.importEntries([{
        name,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        size: blob.size,
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

  /* ===== 卡片 ===== */
  function card(s) {
    const media = s.audio
      ? `<audio controls preload="none" src="${esc(s.audio)}"></audio>` +
        (s.matched ? '<span class="mu-match">汽水未开放直链 · 已匹配网易云同名版本</span>' : '')
      : '<span class="mu-noaudio">取直链中…</span>';
    return `<div class="mu-item" style="--mc:${s.color}">
      <div class="mu-cover ${s.cover ? 'has-img' : ''}">${s.cover ? '<img src="' + esc(s.cover) + '" referrerpolicy="no-referrer" alt="">' : ''}<span class="mu-note">${svg()}</span></div>
      <div class="mu-info">
        <div class="mu-title"><span class="mu-note-sm">${svg()}</span>${esc(s.title)}</div>
        <div class="mu-artist">${esc(s.artist || ' ')}</div>
        <div class="mu-media">${media}</div>
        <div class="mu-enrich"></div>
      </div>
      <div class="mu-actions">
        <button type="button" class="mu-btn-dl" ${s.audio ? '' : 'disabled'}>下载音乐</button>
        <button type="button" class="mu-btn-save" ${s.audio ? '' : 'disabled'}>存到壁纸库</button>
        <button type="button" class="mu-btn-open">打开原曲</button>
      </div>
    </div>`;
  }

  function bindCard(row, s) {
    const dl = row.querySelector('.mu-btn-dl');
    if (dl) { dl.disabled = !s.audio; dl.onclick = () => download(s, dl); }
    const sv = row.querySelector('.mu-btn-save');
    if (sv) { sv.disabled = !s.audio; sv.onclick = () => saveToLibrary(s, sv); }
    const op = row.querySelector('.mu-btn-open');
    if (op) op.onclick = () => window.open(s.page || NE, '_blank', 'noopener');
    const a = row.querySelector('audio');
    if (a) a.addEventListener('error', () => {
      if (a.dataset.tried) return;
      a.dataset.tried = '1';
      /* 只有网易云才可能用 outer 端点兜底；汽水匹配来的音频失败就不再折腾 */
      if (s.platform === 'netease' && s.id) { a.src = outerURL(s.id); a.load(); }
    });
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
      '<div class="mu-foot">本地毫秒级出卡片；歌名/歌手/封面与汽水直链由自家仓库中转补齐（GitHub Actions 调平台官方接口）。点【下载音乐】存 MP3，点【存到壁纸库】永久进「壁纸 → 音乐」。版权归原平台及权利人，仅个人试听收藏。</div>';
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

  /* ===== 双平台自测：识别 + 直链 + 自家缓存 三项体检 ===== */
  async function selftest(container) {
    const box = typeof container === 'string' ? $(container) : container;
    if (!box) return [];
    const songs = DEMOS.map(d => parse(d.url + ' ' + d.text));
    const checked = PLATS.map((p, i) => ({ p, ok: !!(songs[i] && songs[i].platform === p.key && songs[i].id) }));
    renderInto(box, songs, '双平台自测 · 识别 ' + checked.filter(x => x.ok).length + '/' + PLATS.length);
    const line = document.createElement('div');
    line.className = 'mu-testline';
    line.innerHTML = checked.map(x => `<span class="mu-test ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✔' : '✘'} 识别 ${esc(x.p.short)}</span>`).join('') +
      '<span class="mu-test" id="mu-test-audio">直链检测中…</span>' +
      '<span class="mu-test" id="mu-test-cache">自家缓存检测中…</span>';
    const head = box.querySelector('.mu-head');
    if (head) head.insertAdjacentElement('afterend', line);

    /* 直链实测：真发一次请求，验证「下载音乐」这条路通不通 */
    try {
      const r = await fetch(songs[0].audio, { signal: AbortSignal.timeout(12000) });
      const el = $('mu-test-audio');
      if (el) {
        let sizeTxt = '';
        try { if (r.ok && r.headers.get('content-length')) sizeTxt = '（' + fmtSize(Number(r.headers.get('content-length'))) + '）'; } catch (e) {}
        el.className = 'mu-test ' + (r.ok ? 'ok' : 'bad');
        el.textContent = r.ok ? '直链可用' + sizeTxt : '直链异常 HTTP ' + r.status;
        try { if (r.body) await r.body.cancel(); } catch (e) {}
      }
    } catch (e) {
      const el = $('mu-test-audio');
      if (el) { el.className = 'mu-test bad'; el.textContent = '直链取不到（跨域/超时）'; }
    }
    /* 自家缓存体检 */
    try {
      const hits = [];
      for (const sc of songs) {
        let key = '';
        try { if (typeof parseCacheKey === 'function') key = parseCacheKey(sc.page || sc.url) || ''; } catch (e) {}
        if (!key) key = (sc.platform === 'netease' ? 'netease:' : 'qishui:') + sc.id;
        const e = (typeof serverCacheGet === 'function') ? await serverCacheGet(key, { ms: 6000 }) : null;
        hits.push(!!(e && e.kind === 'music' && !e.err));
      }
      const el = $('mu-test-cache');
      if (el) {
        el.className = 'mu-test ' + (hits.some(Boolean) ? 'ok' : '');
        el.textContent = '自家缓存 ' + hits.filter(Boolean).length + '/' + hits.length;
      }
    } catch (e) {
      const el = $('mu-test-cache');
      if (el) { el.className = 'mu-test bad'; el.textContent = '缓存检测失败'; }
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
.mu-match{display:inline-block;margin-top:4px;font-size:10px;color:#b45309;background:#fffbeb;border-radius:6px;padding:2px 6px}
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
      inp.addEventListener('paste', () => setTimeout(() => {
        if (detect(inp.value)) runInto(inp.value, 'mu-result');
      }, 100));
    }
    const test = $('mu-test');
    if (test) test.addEventListener('click', () => selftest('mu-result'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { parse, runInto, selftest, detect, renderInto, outerURL, PLATS, DEMOS };
})();
