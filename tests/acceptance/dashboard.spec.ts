import { test, expect } from "@playwright/test";
import {
  emptyDashboard,
  emptyCommon,
} from "../../packages/contracts/src/index";
test("unconfigured dashboard has clock/cards/settings with no invented live data", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("地域未設定")).toBeVisible();
  await expect(page.getByText("フィード未登録")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Claude 利用状況" }),
  ).toBeVisible();
  await expect(page.getByText("音源未設定", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "設定" }).click();
  await page.getByRole("checkbox", { name: "12時間表記" }).check();
  await page.getByRole("button", { name: "時計に戻る" }).click();
  await expect(page.getByTestId("clock-time")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "設定" }).click();
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

test("large clock reflows on rotation without colliding with its supporting information", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  for (const [width, height] of [
    [1280, 800],
    [800, 1280],
    [360, 800],
    [800, 360],
    [320, 240],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    const hours = await page.locator(".clock-hours").boundingBox();
    const minutes = await page.locator(".clock-minutes").boundingBox();
    const face = await page.locator(".clock-face").boundingBox();
    const details = await page.locator(".clock-details").boundingBox();
    const clock = await page
      .getByRole("region", { name: "時計" })
      .boundingBox();
    const cards = await page.locator(".bottom-grid").boundingBox();
    expect(hours && minutes && face && details && clock && cards).toBeTruthy();
    if (!hours || !minutes || !face || !details || !clock || !cards)
      throw new Error("Missing clock layout");
    for (const box of [hours, minutes, details]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(details.y).toBeGreaterThanOrEqual(face.y + face.height);
    expect(cards.y).toBeGreaterThanOrEqual(clock.y + clock.height);
    if (height > width) {
      expect(minutes.y).toBeGreaterThanOrEqual(hours.y + hours.height);
      expect(Math.abs(minutes.x - hours.x)).toBeLessThan(1);
      await expect(page.locator(".clock-separator")).toBeHidden();
    } else {
      expect(Math.abs(minutes.y - hours.y)).toBeLessThan(1);
      expect(minutes.x).toBeGreaterThan(hours.x + hours.width);
      await expect(page.locator(".clock-separator")).toBeVisible();
    }
    const size = await page
      .getByTestId("clock-time")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThan(
      Math.min(width * (height > width ? 0.38 : 0.2), height * 0.3),
    );
    const secondsSize = await page
      .getByTestId("clock-seconds")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThan(secondsSize * 3.5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole("button", { name: "設定" })).toBeVisible();
  }
});

test("configured supporting cards and RSS controls fit the narrower card columns", async ({
  page,
}) => {
  const data = emptyDashboard();
  const now = new Date().toISOString();
  data.weather = {
    ...data.weather,
    ...emptyCommon("ok"),
    regionId: "test",
    regionLabel: "テスト用予報地域",
    receivedAt: now,
  };
  data.rss = [
    {
      ...emptyCommon("ok"),
      id: "test",
      label: "LayoutTestFeed",
      lastSuccessAt: now,
      items: Array.from({ length: 4 }, (_, index) => ({
        id: String(index),
        title: `テスト用の長いニュース見出し ${index}`,
        url: null,
        publishedAt: now,
        sourceLabel: "LongUnbrokenTestSourceLabelForNarrowCards",
      })),
    },
  ];
  for (const usage of data.usage)
    usage.buckets = [
      {
        id: "test",
        label: "テスト用の利用枠",
        windows: [
          {
            id: "test",
            label: "5時間の利用枠",
            usedPercent: 50,
            windowMinutes: 300,
            resetsAt: null,
          },
        ],
      },
    ];
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: "切替を停止" })).toBeVisible();
  for (const width of [1000, 800, 360]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const cards = await page.locator(".card").evaluateAll((nodes) =>
      nodes.map((node) => ({
        width: node.clientWidth,
        scroll: node.scrollWidth,
      })),
    );
    for (const card of cards)
      expect(card.scroll).toBeLessThanOrEqual(card.width);
    await page.getByRole("button", { name: "切替を停止" }).click();
    await expect(
      page.getByRole("button", { name: "切替を再開" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "切替を再開" }).click();
  }
});
