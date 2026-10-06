// Service Worker(M4): オフラインで使えるように、サイトのファイルをすべて手元に保存する。
// ビルド時に vite.config.ts が、版と事前キャッシュの一覧を埋めて dist/sw.js を書き出す。
//
// HC-1 / HC-2: 同じオリジンへの GET だけを扱い、外部へのリクエストには一切関与しない
// (そもそもページ側の CSP で外部通信は止めている)。ここから外部へ通信するコードは書かないこと。
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const PREFIX = 'pdf-sagyodai-';
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

// 新しい版への切り替えは、利用者が「更新する」を押したときだけ行う(作業中のページを勝手に入れ替えない)
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ページそのもの(ナビゲーション)には、保存してある index.html を返す
      const key = request.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : request;
      // ignoreVary: サーバーが Vary(Origin / Accept-Encoding)を返すと、crossorigin 付きの読み込みが一致しなくなるため
      const hit = await cache.match(key, { ignoreSearch: true, ignoreVary: true });
      return hit ?? fetch(request);
    })(),
  );
});
