/**
 * 自研渲染解析引擎（parser/render.mjs）
 * 用真实浏览器打开平台页面——页面自己的 JS 会带合法签名去要数据，
 * 等于让平台"亲手"把直链交出来。全程自己的代码，不调任何第三方解析接口。
 *
 * 已验证（2026-11-10 本机实测）：
 *   抖音  www.douyin.com/video/{id}          → douyinvod.com 正片 MP4（7MB 可下载）
 *   快手  www.kuaishou.com/short-video/{id}  → djvod.ndcimgs.com 正片（需重试对抗风控）
 *   B站   继续走 parser/engine.mjs 的公开接口（秒级，不必动用浏览器）
 *   小红书 www.xiaohongshu.com/explore/{id}  → 需登录态 cookie（见 opt.cookies）
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 指纹池：每次尝试换一套，降低被识别概率 */
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
];

/* 正片视频地址特征（排除 UI 音效 / JS / 静态资源 / 封面图） */
const VID_CDN = /douyinvod|djvod|ndcimgs|sns-video/i;          // 纯视频 CDN
const VID_HYBRID = /yximgs|kwimgs|chenzhongtech/i;              // 图+视频混合 CDN
const VID_EXT = /\.(mp4|m3u8|flv)(\?|#|$)/i;
const VID_PARAM = /aweme\/v1\/play|video_id=|playUrl|play_addr/i;
const VID_UI = /douyinstatic\.com\/obj\/douyin-pc-web|kcdn|static\.|\.js(\?|#|$)|effect|sound|uuu_\d/i;

function isVideoURL(u) {
  if (!u || /^blob:|^data:/i.test(u)) return false;
  if (VID_UI.test(u)) return false;
  if (VID_EXT.test(u)) return true;                 // 明确视频扩展名
  if (VID_CDN.test(u)) return true;                 // 纯视频 CDN
  if (VID_PARAM.test(u)) return true;               // 播放接口参数
  if (VID_HYBRID.test(u)) {
    /* yximgs/kwimgs 既托管封面图也托管视频：只有路径像视频才算 */
    return /\/(play|mv|video|short|photoMv|multiVideo|mp4|m3u8|v\.|webm)\b/i.test(u);
  }
  return false;
}

/* 图片 CDN 白名单 + UI 图过滤 */
const IMG_HOST = /xhscdn|douyinpic|yximgs|kwimgs|snssdk|pstatp|byteimg|chenzhongtech|sns-webpic|p3-pc-sign|p26-pc-sign|p9-pc-sign|videostatic/i;
const IMG_EXT = /\.(jpe?g|png|webp|heic|avif|gif)(\?|#|$)/i;
const IMG_UI = /avatar|uhead|logo|icon|sprite|emoji|badge|qrcode|beacon|report|feedback|loading|placeholder|twemoji|emblem|get_app|fold_get|hover|btn|bg_|nav|tab|banner/i;
/* 抖音/快手 PC 端的界面素材（下载按钮、图标等），.png 后缀但绝非作品内容 */
const IMG_ASSET = /douyinstatic\.com\/obj\/douyin-pc-web|kuaishou-static|ks-img|kwai-static|static\d*\.?/i;

function isImageURL(u) {
  if (!u || /^blob:|^data:/i.test(u)) return false;
  if (IMG_UI.test(u)) return false;
  if (IMG_ASSET.test(u)) return false;
  return IMG_HOST.test(u) || IMG_EXT.test(u);
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[-_|·—]\s*(抖音|快手|小红书|douyin\.com|kuaishou\.com|xiaohongshu\.com).*$/i, '')
    .replace(/\s*[-_|·—]\s*(抖音|快手|小红书)\s*$/i, '')
    .trim().slice(0, 80) || '网页作品';
}

async function launchBrowser(chromium, attempt) {
  const args = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled',
    '--lang=zh-CN',
    '--disable-dev-shm-usage',
  ];
  /* 可选代理（CN IP 出口）绕过抖音/小红书对境外 IP 的风控；留空则直连 */
  const proxy = process.env.PARSE_PROXY ? { server: process.env.PARSE_PROXY } : undefined;
  const base = { args, ...(proxy ? { proxy } : {}) };
  /* 优先用本机 Edge（免下载、CN IP 最稳）；没有再退回 Playwright 自带 Chromium（CI 用） */
  try {
    return await chromium.launch({ channel: 'msedge', ...base });
  } catch (e) {
    return await chromium.launch(base);
  }
}

async function newFingerprint(browser, attempt) {
  const ctx = await browser.newContext({
    userAgent: UA_POOL[attempt % UA_POOL.length],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280 + attempt * 13, height: 800 + attempt * 9 },
  });
  /* 抹掉自动化痕迹 */
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
    try {
      window.chrome = window.chrome || { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    } catch (e) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] }); } catch (e) {}
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }, { name: 'Native Client' }],
      });
    } catch (e) {}
    try {
      const origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = (p) =>
          p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(p);
      }
    } catch (e) {}
  });
  return ctx;
}

/* 把 "a=1; b=2" 形式的 cookie 字符串转成 playwright cookies */
function parseCookies(str, domains) {
  if (!str) return [];
  return String(str).split(';').map(s => s.trim()).filter(Boolean).map(kv => {
    const i = kv.indexOf('=');
    const name = kv.slice(0, i).trim();
    const value = kv.slice(i + 1).trim();
    const out = [];
    for (const d of domains) out.push({ name, value, domain: d, path: '/' });
    return out;
  }).flat().filter(c => c.name && c.value);
}

/**
 * 渲染解析主入口
 * @param {string} url 平台作品链接
 * @param {object} opt { kind:'video'|'images'|'auto', cookies:'a=1; b=2', cookieDomains:['.xiaohongshu.com'], attempts:3, timeout:45000 }
 * @returns {Promise<{kind,play?,images?,title,cover,via}|null>}
 */
export async function renderParse(url, opt = {}) {
  let pw;
  try { pw = await import('playwright'); } catch (e) {
    throw new Error('playwright 未安装（npm i playwright && npx playwright install chromium）');
  }
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) throw new Error('playwright 模块异常：找不到 chromium（请重装 playwright）');
  const attempts = Math.max(1, opt.attempts || 3);
  const wantImages = opt.kind === 'images';
  let lastErr = '';

  for (let attempt = 0; attempt < attempts; attempt++) {
    let browser;
    try {
      browser = await launchBrowser(chromium, attempt);
      const ctx = await newFingerprint(browser, attempt);
      if (opt.cookies && opt.cookieDomains) {
        const cs = parseCookies(opt.cookies, opt.cookieDomains);
        if (cs.length) await ctx.addCookies(cs).catch(() => {});
      }
      const page = await ctx.newPage();
      const netVids = [], netImgs = [], playApiURLs = [];
      page.on('response', async (res) => {
        const u = res.url();
        try {
          /* 抖音 aweme/v1/play 接口返回的 JSON 里带最高画质直链（url_list），
             这是平台"亲手"给的、可直连的 canonical 地址，优先采用 */
          if (/aweme\/v1\/play|video\/play|play\?|play_addr/i.test(u) && !/static\.|\.js|effect|sound/.test(u)) {
            const j = await res.json().catch(() => null);
            if (j) {
              const lists = [];
              const walk = (o) => {
                if (!o || typeof o !== 'object') return;
                if (Array.isArray(o)) { o.forEach(walk); return; }
                for (const k in o) {
                  if (k === 'url_list' && Array.isArray(o[k])) lists.push(...o[k]);
                  else if (typeof o[k] === 'object') walk(o[k]);
                }
              };
              walk(j);
              lists.forEach(x => { if (x && !playApiURLs.includes(x)) playApiURLs.push(x); });
            }
          }
        } catch (e) { /* 非 JSON 体，忽略 */ }
        if (isVideoURL(u)) netVids.push(u);
        else if (isImageURL(u)) netImgs.push(u);
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opt.timeout || 45000 })
        .catch(e => { lastErr = '打开页面失败：' + String(e.message || e).slice(0, 80); });

      /* 拟人操作：随机移动鼠标 + 轻滚，降低无头浏览器被风控识别的概率 */
      try {
        await page.mouse.move(180 + Math.random() * 420, 160 + Math.random() * 320);
        await page.evaluate(() => { try { window.scrollBy(0, 100 + Math.random() * 120); } catch (e) {} });
        await sleep(300 + Math.random() * 500);
      } catch (e) { /* 导航中，忽略 */ }

      let domV = '', poster = '', title = '', domImgs = [];
      const deadline = Date.now() + (opt.wait || 45000);
      while (Date.now() < deadline) {
        /* 快手风控页会出现「点击重试」按钮，模拟真实用户点掉 */
        try {
          const retry = await page.$('text=点击重试', { timeout: 300 }).catch(() => null);
          if (retry) await retry.click({ timeout: 800 }).catch(() => {});
        } catch (e) { /* 页面导航中，忽略 */ }
        try {
          const d = await page.evaluate(() => {
            /* headless 下 video 不会自动起播，真实 CDN 直链就不会进网络请求——主动静音播放 */
            const vs = [].slice.call(document.querySelectorAll('video'));
            const v = vs.find(x => x.currentSrc && !/^blob:/i.test(x.currentSrc)) || vs[0];
            if (v) { try { v.muted = true; v.preload = 'auto'; v.play().catch(() => {}); } catch (e) {} }
            const sources = [];
            vs.forEach(x => {
              if (x.currentSrc && !/^blob:/i.test(x.currentSrc)) sources.push(x.currentSrc);
              if (x.src && !/^blob:/i.test(x.src)) sources.push(x.src);
              [].slice.call(x.querySelectorAll('source')).forEach(s => s.src && sources.push(s.src));
            });
            const imgs = [];
            [].slice.call(document.images).forEach(m => { const s = m.currentSrc || m.src; if (s) imgs.push(s); });
            document.querySelectorAll('[style*="background-image"]').forEach(el => {
              const mm = (el.getAttribute('style') || '').match(/url\(["']?([^"')]+)["']?\)/);
              if (mm) imgs.push(mm[1]);
            });
            /* 资源计时里可能已有真实播放地址（比 DOM 更可靠） */
            let perfVid = '';
            try {
              performance.getEntriesByType('resource').forEach(e => {
                const n = e.name;
                if (!perfVid && /douyinvod|djvod|ndcimgs|yximgs|kwimgs|chenzhongtech|aweme\/v1\/play|video_id=|\.(mp4|m3u8|flv)(\?|#|$)/i.test(n) && !/static\.|kcdn|\.js/.test(n)) perfVid = n;
              });
            } catch (e) {}
            /* 标题多源兜底：og:title → h1 → 官方文案节点 → description → 页面标题 */
            const og = (document.querySelector('meta[property="og:title"]') || {}).content || '';
            const desc = (document.querySelector('meta[name="description"]') || {}).content || '';
            const h1 = (document.querySelector('h1') || {}).innerText || '';
            const e2e = (document.querySelector('[data-e2e="video-title"]') || document.querySelector('.caption') || {}).innerText || '';
            const rawT = og || h1 || e2e || desc || document.title || '';
            const t = rawT.replace(/\s*[-_|·—]\s*(抖音|快手|小红书|douyin\.com|kuaishou\.com|xiaohongshu\.com).*$/i, '').trim()
              || rawT.replace(/\s*[-_|·—]\s*(抖音|快手|小红书)\s*$/i, '').trim();
            /* 风控页检测：出现验证/滑块/人机则这一轮基本拿不到媒体，尽早换指纹重试 */
            const bodyText = (document.body && document.body.innerText) || '';
            const risk = /验证|拖动滑块|slide.{0,4}verify|security check|人机|验证码|unusual traffic|robot|请完成|verify you are human/i.test(bodyText)
              || /verify|验证|安全验证/i.test(document.title);
            return {
              v: v ? (v.currentSrc || v.src || '') : '',
              sources, perfVid,
              p: v ? (v.poster || '') : '',
              t,
              imgs,
              risk,
            };
          });
          domV = d.v || d.perfVid || (d.sources.find(isVideoURL) || '');
          d.sources.forEach(s => { if (!netVids.includes(s)) netVids.push(s); });
          poster = d.p; title = d.t; domImgs = d.imgs;
        } catch (e) { /* 页面跳转销毁上下文，下一轮再来 */ }

        const hasVid = isVideoURL(domV) || netVids.length > 0;
        const hasImgs = domImgs.filter(isImageURL).length >= 3 || netImgs.length >= 4;
        if (hasVid || hasImgs) break;
        /* 风控验证页基本拿不到媒体，别空等一轮，直接换指纹重试 */
        if (typeof d !== 'undefined' && d.risk) { lastErr = '页面触发风控验证，换指纹重试'; break; }
        await sleep(700);
      }

      /* 汇总候选，按可信度排序 */
      const vidCands = [];
      /* 优先采用播放接口给的 canonical 直链（最高画质），再退回到 DOM/网络捕获到的地址 */
      const allVids = [...playApiURLs, ...(isVideoURL(domV) ? [domV] : []), ...netVids];
      const hostScore = (u) => (/douyinvod/.test(u) ? 5 : /lf-douyin-pc-web/.test(u) ? 4 : /djvod|ndcimgs/.test(u) ? 3 : /yximgs|kwimgs|chenzhongtech/.test(u) ? 2 : /aweme\/v1\/play|video_id=/.test(u) ? 1 : 0);
      allVids.sort((a, b) => hostScore(b) - hostScore(a));
      [...new Set(allVids)].forEach(u => { if (u) vidCands.push(u); });
      const play = vidCands.find(Boolean) || '';

      const imgCands = [...domImgs, ...netImgs].filter(isImageURL);
      const images = [...new Set(imgCands)].slice(0, 40);

      await browser.close(); browser = null;

      if (play) {
        return { kind: 'video', play, title: cleanTitle(title), cover: poster || images[0] || '', via: '渲染引擎' };
      }
      if (images.length >= 3) {
        return { kind: 'images', images, title: cleanTitle(title), cover: images[0], via: '渲染引擎' };
      }
      lastErr = '页面没加载出媒体（可能触发风控或需要登录）';
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 120);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    /* 没拿到就换指纹再来一次；间隔拉长，避免硬砸触发风控 */
    if (attempt < attempts - 1) await sleep(2500 + attempt * 2500);
  }
  throw new Error('渲染引擎未拿到直链：' + lastErr);
}

export default { renderParse };
