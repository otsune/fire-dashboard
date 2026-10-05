/* Generated as a versioned, self-contained worker by scripts/build-sw.mjs. */
const CACHE = "fire-shell-__VERSION__";
const ASSETS = __ASSETS__;
const ASSET_PATHS = new Set(
  ASSETS.map((asset) => new URL(asset, self.location.origin))
    .filter((asset) => asset.origin === self.location.origin)
    .map((asset) => asset.pathname),
);
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        await cache.addAll(ASSETS);
        await cache.put("/__complete__", new Response("ready"));
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
    })(),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data === "ACTIVATE_UPDATE")
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE);
        if (await cache.match("/__complete__")) await self.skipWaiting();
      })(),
    );
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      if (!(await cache.match("/__complete__"))) return;
      for (const name of await caches.keys())
        if (name.startsWith("fire-shell-") && name !== CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (event.request.mode === "navigate") {
        const shell = await cache.match("/index.html");
        if (!shell) return fetch(event.request);
        // Servers such as Go's http.FileServer (tailscale serve) redirect
        // /index.html to "/", and a redirected response cannot answer a
        // navigation, so serve an unredirected copy.
        return shell.redirected
          ? new Response(shell.body, {
              status: shell.status,
              statusText: shell.statusText,
              headers: shell.headers,
            })
          : shell;
      }
      return (
        (await cache.match(event.request, {
          ignoreSearch: true,
          // Declared build URLs have fixed bytes. Precache requests lack the
          // page's Origin, so Vary: Origin must not hide these offline assets.
          ignoreVary: ASSET_PATHS.has(url.pathname),
        })) || fetch(event.request)
      );
    })(),
  );
});
