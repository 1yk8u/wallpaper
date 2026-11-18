/* 全站加速 Service Worker
 * 目标：输入网址二次打开秒开 —— 页面/CSS/JS/首屏清单全部走本地缓存。
 * 策略：
 *   - 页面导航：缓存优先秒出，后台静默更新（固定 key，不堆积随机参数）
 *   - 首屏清单 hero.json / 完整清单：stale-while-revalidate
 *   - 应用外壳 JS/CSS：cache-first（带 ?v= 版本号，升级天然破缓存）
 *   - 缩略图/同源封面：cache-first，限量淘汰；原图不缓存，不占手机空间
 */
const SHELL = 'wp-shell-v2';
const MEDIA = 'wp-media-v2';
const SHELL_LIMIT = 80;
const MEDIA_LIMIT = 600;

self.addEventListener('install', event => {
  self.skipWaiting();
  /* 首次安装预取首页外壳，让安装完成后的第一次回访就能命中 */
  event.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.allSettled(['./', './index.html'].map(u => c.add(new Request(u, { cache: 'reload' }))));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== MEDIA).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(c, limit) {
  try {
    const keys = await c.keys();
    if (keys.length > limit) {
      await Promise.all(keys.slice(0, keys.length - limit).map(k => c.delete(k)));
    }
  } catch (e) {}
}

/* 后台静默更新，不阻塞页面显示 */
function revalidate(req, cacheName) {
  fetch(req, { cache: 'reload' }).then(res => {
    if (res && res.ok) caches.open(cacheName).then(c => c.put(req, res.clone()));
  }).catch(() => {});
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (e) { return; }
  if (u.origin !== self.location.origin) return;
  const p = u.pathname;

  /* 页面导航：缓存优先秒出，后台更新固定 key */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const key = './index.html';
      const hit = await c.match(key);
      fetch('./index.html?sw=' + Date.now(), { cache: 'reload' })
        .then(res => { if (res.ok) c.put(key, res.clone()); }).catch(() => {});
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) c.put(key, res.clone());
        return res;
      } catch (e) { return Response.error(); }
    })());
    return;
  }

  /* 清单：stale-while-revalidate，先用缓存出图，后台拉新 */
  if (/data\/(hero|wallpapers)\.json/.test(p)) {
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req);
      revalidate(req, SHELL);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trim(c, SHELL_LIMIT); }
        return res;
      } catch (e) { return Response.error(); }
    })());
    return;
  }

  /* 应用外壳 JS/CSS/其它静态：cache-first，版本号升级自动拉新 */
  if (/\.(js|css|webmanifest)$/.test(p)) {
    event.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trim(c, SHELL_LIMIT); }
        return res;
      } catch (e) { return hit || Response.error(); }
    })());
    return;
  }

  /* 缩略图与同源封面：cache-first，二次打开几乎秒出 */
  if (/\/thumbs\/|\/data\/(covers|xmedia)\//.test(p)) {
    event.respondWith((async () => {
      const c = await caches.open(MEDIA);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trim(c, MEDIA_LIMIT); }
        return res;
      } catch (e) { return hit || Response.error(); }
    })());
  }
});
