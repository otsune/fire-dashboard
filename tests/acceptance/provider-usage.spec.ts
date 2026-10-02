import { test, expect } from "@playwright/test";
import {
  emptyDashboard,
  emptyCommon,
  usageProviders,
} from "../../packages/contracts/src/index";

test("five provider cards preserve missing, quota and balance semantics at tablet and narrow widths", async ({
  page,
}) => {
  const data = emptyDashboard();
  const now = new Date().toISOString();
  for (const provider of ["antigravity", "opencode_go"] as const) {
    Object.assign(
      data.usage.find((u) => u.provider === provider)!,
      {
        ...emptyCommon("ok"),
        receivedAt: now,
        buckets: [
          {
            id: "fixture",
            label: "テスト用の利用枠",
            windows: [
              {
                id: "fixture",
                label: "長い利用枠名の表示確認",
                usedPercent: 42,
                windowMinutes: null,
                resetsAt: null,
              },
            ],
          },
        ],
      },
    );
  }
  Object.assign(
    data.usage.find((u) => u.provider === "hermes_nous")!,
    {
      ...emptyCommon("ok"),
      receivedAt: now,
      balance: {
        currency: "USD",
        subscriptionRemaining: 25,
        purchasedRemaining: 12,
        totalRemaining: 37,
        monthlyAllowance: 20,
        renewsAt: null,
      },
    },
  );
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/");
  await expect(page.locator(".usage-card")).toHaveCount(usageProviders.length);
  await expect(page.locator(".usage-card progress")).toHaveCount(2);
  const nous = page.locator(".usage-card").filter({
    has: page.getByRole("heading", { name: /Hermes \/ Nous.*利用状況/ }),
  });
  await expect(nous).toContainText("$37.00");
  await expect(nous.locator("progress")).toHaveCount(0);
  for (const [width, height] of [
    [1280, 800],
    [800, 1280],
    [360, 800],
  ]) {
    await page.setViewportSize({ width, height });
    const usage = await page.locator(".usage-grid").boundingBox();
    const rss = await page.locator(".rss-card").boundingBox();
    const last = await page.locator(".usage-card").last().boundingBox();
    expect(usage && rss && last).toBeTruthy();
    if (!usage || !rss || !last) throw new Error("Missing provider layout");
    if (width >= 1000) {
      expect(rss.x).toBeGreaterThanOrEqual(usage.x + usage.width);
      expect(Math.abs(rss.y - usage.y)).toBeLessThan(1);
    } else {
      expect(rss.y).toBeGreaterThanOrEqual(usage.y + usage.height);
    }
    // With five visible providers the last card fills the two-column usage row.
    expect(Math.abs(last.width - usage.width)).toBeLessThan(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const card of await page.locator(".usage-card").all()) {
      expect(
        await card.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    await page.getByRole("button", { name: "設定" }).click();
    await page.getByRole("button", { name: "時計に戻る" }).click();
    await expect(page.locator(".usage-card")).toHaveCount(5);
  }
});

test("unconfigured extra providers do not displace the desktop RSS column", async ({
  page,
}) => {
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: emptyDashboard() }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.locator(".usage-card")).toHaveCount(2);
  const usage = await page.locator(".usage-grid").boundingBox();
  const rss = await page.locator(".rss-card").boundingBox();
  expect(usage && rss).toBeTruthy();
  if (!usage || !rss) throw new Error("Missing default provider layout");
  expect(rss.x).toBeGreaterThanOrEqual(usage.x + usage.width);
  expect(Math.abs(rss.y - usage.y)).toBeLessThan(1);
});
