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
}) => {
  await page.goto("/");
  await expect(page.getByText("オフライン準備完了")).toBeVisible();
  const time = await page.getByTestId("clock-seconds").textContent();
  await context.setOffline(true);
  await expect(page.getByTestId("clock-seconds")).not.toHaveText(time!);
  await page.reload();
  await expect(page.getByTestId("clock-time")).toBeVisible();
  await expect(page.getByText("地域未設定")).toBeVisible();
  await context.setOffline(false);
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
