import { test, expect } from "@playwright/test";
import {
  emptyDashboard,
  emptyCommon,
} from "../../packages/contracts/src/index";

test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  const stamp = new Date().toISOString();
  const data = emptyDashboard();
  data.rss = [
    {
      ...emptyCommon("ok"),
      receivedAt: stamp,
      capturedAt: stamp,
      sourceObservedAt: stamp,
      lastSuccessAt: stamp,
      freshness: "known",
      id: "ticker",
      label: "Ticker",
      items: [
        "長いニュース見出しを最後まで読めるよう右から左にスクロールします。".repeat(
          4,
        ),
        "次のニュース",
      ].map((title, i) => ({
        id: String(i),
        title,
        url: `https://example.com/${i}`,
        sourceLabel: "Ticker",
        publishedAt: stamp,
      })),
    },
  ];
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/");
  await expect(page.locator(".headline-preview article")).toBeVisible();
  await page.mouse.move(0, 0);
});

test("ticker moves, pauses, resumes and advances only after the whole headline", async ({
  page,
}) => {
  const article = page.locator(".headline-preview article");
  await expect
    .poll(() => article.evaluate((el) => el.getAnimations().length))
    .toBe(1);
  const position = () =>
    article.evaluate((el) => Number(el.getAnimations()[0].currentTime));
  const before = await position();
  await expect.poll(position).toBeGreaterThan(before + 100);
  const link = article.locator("a");
  expect(
    await link.evaluate((el) => getComputedStyle(el).textDecorationLine),
  ).toBe("none");
  expect(await link.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    "28px",
  );
  await page.getByRole("button", { name: "切替を停止", exact: true }).click();
  await expect
    .poll(() => article.evaluate((el) => el.getAnimations()[0].playState))
    .toBe("paused");
  const stopped = await position();
  await page.waitForTimeout(300);
  expect(await position()).toBe(stopped);
  await page.getByRole("button", { name: "切替を再開", exact: true }).click();
  await expect.poll(position).toBeGreaterThan(stopped);
  await article.evaluate((el) => {
    const a = el.getAnimations()[0];
    a.currentTime = 16000;
  });
  await expect(link).toHaveText(/長いニュース/);
  await article.evaluate((el) => el.getAnimations()[0].finish());
  await expect(article).toHaveText("次のニュース");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("reading focus pauses the ticker and details are unlined", async ({
  page,
}) => {
  const article = page.locator(".headline-preview article");
  await article.locator("a").focus();
  await expect
    .poll(() => article.evaluate((el) => el.getAnimations()[0].playState))
    .toBe("paused");
  await page.getByText("すべての見出し", { exact: true }).click();
  const link = page.locator(".headlines a").first();
  await expect(link).toBeVisible();
  expect(
    await link.evaluate((el) => getComputedStyle(el).textDecorationLine),
  ).toBe("none");
});

test("reduced motion uses readable static headlines", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const article = page.locator(".headline-preview article");
  await expect(article).toHaveText(/長いニュース/);
  expect(await article.evaluate((el) => el.getAnimations().length)).toBe(0);
  expect(await article.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe(
    "normal",
  );
});
