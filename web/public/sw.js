// 真题词库 · Service Worker
// 策略：
//   - /api/* 永远直连网络（数据必须新鲜，也避免缓存到别人的查询结果）
//   - 页面导航 network-first（保证部署后第一时间拿到新版本 HTML）
//   - 静态资源 stale-while-revalidate（先回缓存秒开，后台更新，下次生效）
// 每次改静态资源需递增 VERSION 以清掉旧缓存。
const VERSION = "v15";
const CACHE = `ielts-vocab-${VERSION}`;
const PRECACHE = ["/", "/style.css", "/js/app.js", "/js/pipeline.js", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // 网络优先且不缓存

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // 只缓存成功响应：4xx/5xx 页面（如临时 502）存进 "/" 会被离线兜底长期端出来
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return resp;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
