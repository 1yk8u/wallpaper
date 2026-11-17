/* 图片缓存 Service Worker
 * 只缓存小体积缩略图（thumbs/ 与同源封面），不缓存原图，避免占满手机存储。
 * 清单走网络优先，保证新壁纸能及时出现；断网时回退到缓存。 */
const CACHE = 'wp-thumbs-v1';
const LIMIT = 600;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trim(c) {
  try {
    const keys = await c.keys();
    if (keys.length > LIMIT) {
      await Promise.all(keys.slice(0, keys.length - LIMIT).map(k => c.delete(k)));
    }
  } catch (e) {}
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (e) { return; }
  if (u.origin !== self.location.origin) return;
  const p = u.pathname;

  /* 清单：网络优先，断网回缓存 */
  if (/wallpapers\.json$/.test(p)) {
    event.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (e) {
        return (await c.match(req)) || Response.error();
      }
    })());
    return;
  }

  /* 缩略图与同源封面：缓存优先，二次打开几乎秒出 */
  if (/\/thumbs\/|\/data\/(covers|xmedia)\//.test(p)) {
    event.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trim(c); }
        return res;
      } catch (e) {
        return hit || Response.error();
      }
    })());
  }
});
