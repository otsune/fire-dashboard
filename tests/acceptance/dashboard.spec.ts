import { test, expect } from "@playwright/test";
test("unconfigured dashboard has clock/cards/settings with no invented live data", async ({
  page,
}) => {
  await page.route("**/audio/manifest.json", (route) =>
    route.fulfill({ json: { hours: {}, hours24: {}, chime: null } }),
  );
  await page.goto("/");
  await expect(page.getByText("地域未設定")).toBeVisible();
  await expect(page.getByText("フィード未登録")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Claude 利用状況" }),
  ).toBeVisible();
  await expect(
    page.getByText("24時間表記の音声が未設定", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "時計・音声", exact: true }),
  ).toBeFocused();
  await page.getByRole("checkbox", { name: "12時間表記" }).check();
  await page.getByRole("button", { name: "時計に戻る" }).click();
  await expect(page.getByTestId("clock-time")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "12時間表記" }),
  ).toBeChecked();
});
test("clock continues offline and production shell reloads", async ({
  page,
  context,
}, testInfo) => {
  const assetResponses: {
    url: string;
    offlineReload: boolean;
    status: number;
    fromServiceWorker: boolean;
    origin: string | null;
    vary: string | null;
  }[] = [];
  const assetFailures: { url: string; error: string | undefined }[] = [];
  const pending: Promise<void>[] = [];
  let offlineReload = false;
  const isBootstrapAsset = (url: string) =>
    /\/assets\/.*\.(js|css)$/.test(new URL(url).pathname);
  context.on("response", (response) => {
    if (!isBootstrapAsset(response.url())) return;
    const phase = offlineReload;
    pending.push(
      (async () => {
        assetResponses.push({
          url: response.url(),
          offlineReload: phase,
          status: response.status(),
          fromServiceWorker: response.fromServiceWorker(),
          origin: await response.request().headerValue("origin"),
          vary: await response.headerValue("vary"),
        });
      })(),
    );
  });
  context.on("requestfailed", (request) => {
    if (isBootstrapAsset(request.url()))
      assetFailures.push({
        url: request.url(),
        error: request.failure()?.errorText,
      });
  });
  let beforeOffline;
  try {
    await page.goto("/");
    await expect(page.getByText("オフライン準備完了")).toBeVisible();
    // ready can resolve before clients.claim(); wait for actual page control.
    await expect
      .poll(() =>
        page.evaluate(
          () => navigator.serviceWorker.controller?.state ?? "none",
        ),
      )
      .toBe("activated");
    beforeOffline = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const assets = [
        ...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
          'script[src], link[rel="stylesheet"]',
        ),
      ].map((element) =>
        element instanceof HTMLScriptElement ? element.src : element.href,
      );
      const cachesState = await Promise.all(
        (await caches.keys()).map(async (name) => {
          const cache = await caches.open(name);
          const entries = await Promise.all(
            (await cache.keys()).map(async (request) => ({
              url: request.url,
              origin: request.headers.get("origin"),
              vary: (await cache.match(request))?.headers.get("vary") ?? null,
            })),
          );
          return { name, entries };
        }),
      );
      return {
        assets,
        controller: {
          state: navigator.serviceWorker.controller?.state,
          scriptURL: navigator.serviceWorker.controller?.scriptURL,
        },
        active: registration?.active?.state,
        waiting: registration?.waiting?.state,
        caches: cachesState,
      };
    });
    const time = await page.getByTestId("clock-seconds").textContent();
    await context.setOffline(true);
    await expect(page.getByTestId("clock-seconds")).not.toHaveText(time!);
    offlineReload = true;
    const response = await page.reload();
    expect(response?.status()).toBe(200);
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(page.getByTestId("clock-time")).toBeVisible();
    await expect(page.getByText("地域未設定")).toBeVisible();
    await Promise.all(pending);
    expect(assetFailures).toEqual([]);
    for (const url of beforeOffline.assets)
      expect(
        assetResponses.some(
          (asset) =>
            asset.url === url &&
            asset.offlineReload &&
            asset.status === 200 &&
            asset.fromServiceWorker,
        ),
      ).toBe(true);
  } finally {
    await Promise.allSettled(pending);
    await testInfo.attach("offline-bootstrap-diagnostics", {
      body: JSON.stringify(
        { beforeOffline, assetResponses, assetFailures },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await context.setOffline(false);
  }
});
test("portrait and landscape stay within the viewport and fonts are local", async ({
  page,
}) => {
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fonts.push(request.url());
  });
  await page.goto("/");
  for (const [width, height] of [
    [1280, 800],
    [800, 1280],
    [360, 800],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByTestId("clock-time")).toBeVisible();
  }
  expect(fonts.every((url) => url.startsWith("http://127.0.0.1:4173/"))).toBe(
    true,
  );
});
test("wake lock release is visible and requires user action", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: async () => {
          const lock = new EventTarget() as EventTarget & {
            released: boolean;
            release: () => Promise<void>;
          };
          lock.released = false;
          lock.release = async () => {
            lock.released = true;
            lock.dispatchEvent(new Event("release"));
          };
          (
            window as unknown as { releaseTestLock: () => Promise<void> }
          ).releaseTestLock = lock.release;
          return lock;
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "画面を点灯保持" }).click();
  await expect(page.getByText("画面点灯を保持中")).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { releaseTestLock: () => Promise<void> }
    ).releaseTestLock(),
  );
  await expect(page.getByText("画面点灯の保持が解除されました")).toBeVisible();
});
