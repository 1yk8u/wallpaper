/* =====================================================================
 * netlify/functions/music.mjs —— 音乐分享链接解析后端
 *
 * GET /.netlify/functions/music?url=<分享链接>
 * 支持：网易云音乐 / QQ音乐 / 酷狗音乐 / 汽水音乐
 * 服务端请求（无浏览器跨域限制），返回统一歌曲结构：
 *   { ok, platform, via, finalUrl, songs:[{title,artist,album,cover,audio,page}] }
 * audio 为空时前端显示「打开原曲」（平台未开放直链，不伪造假链接）
 * ===================================================================== */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const PLATS = [
  { key: 'netease', name: '网易云音乐', test: /(?:music\.)?163\.com|163cn\.tv/i },
  { key: 'qq', name: 'QQ音乐', test: /(?:[a-z0-9]+\.)?y\.qq\.com|qm\.qq\.com/i },
  { key: 'kugou', name: '酷狗音乐', test: /kugou\.com/i },
  { key: 'qishui', name: '汽水音乐', test: /qishui\.douyin\.com|music\.douyin\.com|qishui\.com/i },
];

function cors(extra = {}) {
  return { 'Access-Control-Allow-Origin': '*', ...extra };
}
function json(code, obj) {
  return { statusCode: code, headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }), body: JSON.stringify(obj) };
}

async function get(url, opt = {}) {
  const r = await fetch(url, {
    method: opt.method || 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': opt.json ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(opt.headers || {}),
    },
    body: opt.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(opt.timeout || 9000),
  });
  return r;
}
async function getText(url, opt) { const r = await get(url, opt); return { r, text: await r.text(), url: r.url }; }
async function getJSON(url, opt) {
  const r = await get(url, { ...opt, json: true });
  const t = await r.text();
  try { return JSON.parse(t.replace(/^\s*callback\(|\)\s*;?\s*$/g, '')); } catch (e) { return null; }
}
function pickMeta(html, key) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + key + '["\']', 'i');
  const m = html.match(re) || html.match(re2);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';
}
function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function splitTitle(t) {
  let s = t.replace(/[-_—|]\s*(QQ音乐|酷狗音乐|网易云音乐|汽水音乐|单曲|在线试听|高音质|无损|免费下载|音乐|歌曲).*$/i, '').trim();
  const bits = s.split(/\s+[-—–]\s+/);
  if (bits.length >= 2) return { title: bits[0].trim(), artist: bits.slice(1).join(' / ').trim() };
  return { title: s || '未知歌曲', artist: '' };
}
function extractURL(s) {
  const m = String(s || '').match(/https?:\/\/[^\s"'<>，。、）)]+/i);
  return m ? m[0] : '';
}

/* ---------- 网易云音乐 ---------- */
async function netease(finalUrl, html) {
  const idM = (finalUrl + ' ' + html).match(/(?:song[/=]|id=|songId["':=]+\s*)(\d{5,14})/i) ||
             html.match(/\/song\/(\d+)/i) || html.match(/"id"\s*:\s*(\d{6,14})/);
  const id = idM && idM[1];
  if (!id) return null;
  let title = '', artist = '', album = '', cover = '';
  const d = await getJSON('https://music.163.com/api/song/detail?ids=%5B' + id + '%5D', {
    headers: { Referer: 'https://music.163.com/' },
  });
  const s = d && d.songs && d.songs[0];
  if (s) {
    title = s.name || '';
    artist = (s.artists || []).map(a => a.name).join(' / ');
    album = (s.album && s.album.name) || '';
    cover = (s.album && (s.album.picUrl || s.album.blurPicUrl)) || '';
  }
  if (!title) { const t = splitTitle(pickMeta(html, 'og:title') || titleOf(html)); title = t.title; artist = t.artist; }
  if (!cover) cover = pickMeta(html, 'og:image');
  return {
    title, artist, album, cover,
    audio: 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3',
    page: 'https://music.163.com/#/song?id=' + id,
  };
}

/* ---------- QQ音乐 ---------- */
async function qqmusic(finalUrl, html) {
  const midM = (finalUrl + ' ' + html).match(/(?:songDetail\/|songmid[="':=]+\s*|songmid=)([A-Za-z0-9]{10,20})/i) ||
               html.match(/"songmid"\s*:\s*"([A-Za-z0-9]{10,20})"/);
  const mid = midM && midM[1];
  let title = '', artist = '', album = '', cover = '', audio = '';

  const meta = splitTitle(pickMeta(html, 'og:title') || pickMeta(html, 'twitter:title') || titleOf(html));
  title = meta.title; artist = meta.artist;
  cover = pickMeta(html, 'og:image') || pickMeta(html, 'twitter:image');

  if (mid) {
    const d = await getJSON('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' + mid + '&format=json', {
      headers: { Referer: 'https://y.qq.com/' },
    });
    const s = d && d.data && d.data[0];
    if (s) {
      title = s.songname || s.name || title;
      artist = (s.singer || []).map(x => x.name).join(' / ') || artist;
      album = (s.album && s.album.name) || s.albumname || album;
      const amid = s.albummid || (s.album && s.album.mid) || '';
      if (amid && !cover) cover = 'https://y.qq.com/music/photo_new/T002R300x300M000' + amid + '.jpg';
    }
    /* vkey 直链（公开 musicu.fcg，服务端请求无跨域） */
    try {
      const guid = Math.floor(Math.random() * 1e10).toString();
      const payload = {
        req: { module: 'CDN.SrfCdnDispatchServer', method: 'GetCdnDispatch', param: { guid, calltype: 0, userip: '' } },
        req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: { guid, songmid: [mid], songtype: [0], uin: '0', loginflag: 1, platform: '20' } },
        comm: { uin: 0, format: 'json', ct: 20, cv: 0 },
      };
      const v = await getJSON('https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(payload)), {
        headers: { Referer: 'https://y.qq.com/' },
      });
      const info = v && v.req_0 && v.req_0.data && v.req_0.data.midurlinfo && v.req_0.data.midurlinfo[0];
      const sip = v && v.req_0 && v.req_0.data && (v.req_0.data.sip || [])[0];
      if (info && info.purl) audio = (sip || 'https://dl.stream.qqmusic.qq.com/') + info.purl;
    } catch (e) { /* 拿不到就只给跳转 */ }
  }
  if (!title || title === '未知歌曲') return null;
  return {
    title, artist, album, cover, audio,
    page: mid ? 'https://y.qq.com/n/ryqq/songDetail/' + mid : finalUrl,
  };
}

/* ---------- 酷狗音乐 ---------- */
async function kugou(finalUrl, html) {
  const hM = (finalUrl + ' ' + html).match(/(?:hash=|[&#]hash[=/]|["']hash["']\s*:\s*["'])([0-9a-fA-F]{32})/i) ||
             html.match(/([0-9a-fA-F]{32})/);
  const hash = hM && hM[1];
  if (!hash) return null;
  let title = '', artist = '', album = '', cover = '', audio = '';
  const d = await getJSON('https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=' + hash + '&platid=4&mid=1&album_id=0&_=' + Date.now(), {
    headers: { Referer: 'https://www.kugou.com/' },
  });
  const s = d && d.data;
  if (s) {
    title = s.song_name || s.audio_name || '';
    artist = s.author_name || '';
    album = s.album_name || '';
    cover = s.img || '';
    audio = s.play_url || s.play_backup_url || '';
  }
  if (!title) { const t = splitTitle(pickMeta(html, 'og:title') || titleOf(html)); title = t.title; artist = t.artist; }
  if (!cover) cover = pickMeta(html, 'og:image');
  if (audio) audio = audio.replace(/^http:\/\//, 'https://');
  return { title, artist, album, cover, audio, page: 'https://www.kugou.com/song/#hash=' + hash };
}

/* ---------- 汽水音乐 ---------- */
async function qishui(finalUrl, html) {
  const meta = splitTitle(pickMeta(html, 'og:title') || pickMeta(html, 'twitter:title') || titleOf(html));
  const cover = pickMeta(html, 'og:image') || pickMeta(html, 'twitter:image');
  /* 页面内可能带无签名试听片段；只有确认是音频直链才返回，绝不编造 */
  const am = html.match(/(https?:\\?\/\\?\/[^"'\s]+\.(?:mp3|m4a)[^"'\s]*)/i);
  let audio = am ? am[1].replace(/\\\//g, '/').replace(/\\u002F/gi, '/') : '';
  if (audio && !/^https?:\/\//i.test(audio)) audio = '';
  if (!meta.title || meta.title === '未知歌曲') return null;
  return { title: meta.title, artist: meta.artist, album: '', cover, audio, page: finalUrl };
}

/* ---------- 入口 ---------- */
export async function handler(event) {
  const q = event.queryStringParameters || {};
  const raw = q.url || (event.body ? (() => { try { return JSON.parse(event.body).url; } catch (e) { return ''; } })() : '');
  const url = extractURL(raw);
  if (!url) return json(400, { error: '缺少分享链接' });

  const plat = PLATS.find(p => p.test.test(url));
  if (!plat) return json(400, { error: '暂不支持这个链接，支持网易云 / QQ音乐 / 酷狗 / 汽水音乐' });

  try {
    /* 短链先跟随跳转，同时拿到页面 HTML（og:title / og:image 兜底） */
    let finalUrl = url, html = '';
    try {
      const r = await get(url, { timeout: 9000 });
      finalUrl = r.url || url;
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('text/html') !== -1 || ct === '') html = (await r.text()).slice(0, 900000);
    } catch (e) { /* 短链打不开就直接用原链接里的 ID */ }

    let song = null, via = '分享页';
    try {
      if (plat.key === 'netease') song = await netease(finalUrl, html);
      else if (plat.key === 'qq') song = await qqmusic(finalUrl, html);
      else if (plat.key === 'kugou') song = await kugou(finalUrl, html);
      else song = await qishui(finalUrl, html);
    } catch (e) { /* 落到通用 meta */ }

    if (!song) {
      const t = splitTitle(pickMeta(html, 'og:title') || titleOf(html));
      if (!t.title || t.title === '未知歌曲') {
        return json(200, { error: '没识别出歌曲信息（可能链接已失效或需要登录），可点「打开原曲」查看', platform: plat.key, finalUrl, songs: [] });
      }
      song = { title: t.title, artist: t.artist, album: '', cover: pickMeta(html, 'og:image'), audio: '', page: finalUrl };
      via = '网页元信息';
    } else if (song.audio) via = '官方公开直链';

    return json(200, {
      ok: true, platform: plat.key, platformName: plat.name, via,
      finalUrl, songs: [song],
    });
  } catch (e) {
    return json(200, { error: String(e && e.message || e) });
  }
}
