'use strict';
/* =====================================================================
 * parser/free-api.mjs —— 免费聚合解析接口（GitHub Actions 服务端调用）
 *
 * 只处理 抖音 / 快手 / B站 / 小红书 四个平台。
 * 前端无法直连（接口没有 CORS），所以在 Actions 里调，2~3 秒返回无水印直链，
 * 比用无头浏览器渲染快一个数量级。失败时 relay.mjs 自动回退老引擎。
 *
 * 接口返回：{ code:0, data:{ video:[url], images:[url], cover, text, author } }
 * 统一成项目内部结果：{ kind, images, play, cover, title, via }
 * ===================================================================== */

const API = 'https://gateway.diadi.cn/api/parse';
const SECRET = '7vpylQoLLCxgaSKIIlsYrFHsCObBWPAup';

const PLAT = {
  douyin:      { name: '抖音',     re: /douyin\.com|iesdouyin\.com/i },
  kuaishou:    { name: '快手',     re: /kuaishou\.com|chenzhongtech|gifshow\.com/i },
  bilibili:    { name: '哔哩哔哩', re: /bilibili\.com|b23\.tv/i },
  xiaohongshu: { name: '小红书',   re: /xiaohongshu\.com|xhslink\.com/i },
};

export function detect(raw) {
  const s = String(raw || '');
  for (const k in PLAT) if (PLAT[k].re.test(s)) return k;
  return null;
}

async function callAPI(url, timeout = 15000) {
  const u = API + '?app_secret=' + encodeURIComponent(SECRET) +
    '&url=' + encodeURIComponent(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.code !== 0 || !j.data) throw new Error(j.message || j.msg || '接口解析失败');
    return j.data;
  } finally { clearTimeout(timer); }
}

export async function parseByFreeAPI(raw, key) {
  const platform = detect(raw);
  if (!platform) return null;
  const d = await callAPI(raw);
  const videos = (d.video || []).filter(Boolean);
  const images = (d.images || []).filter(Boolean);
  if (!videos.length && !images.length) throw new Error('免费接口未返回媒体');

  const title = String(d.text || d.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const cover = d.cover || '';
  const author = d.author && (d.author.nickname || d.author.name) || '';

  /* 有视频 → video 类型；只有图片 → image 类型 */
  const kind = videos.length ? 'video' : 'image';
  return {
    kind,
    images: kind === 'image' ? images : [],
    play: kind === 'video' ? videos[0] : '',
    cover,
    title: title || (PLAT[platform].name + ' 内容'),
    via: '免费聚合接口',
    platform,
    platformName: PLAT[platform].name,
    author,
    backupPlay: videos.slice(1, 4),
    ts: new Date().toISOString(),
  };
}
