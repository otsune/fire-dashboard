import { test, expect } from "@playwright/test";
import {
  emptyDashboard,
  emptyCommon,
  usageProviders,
} from "../../packages/contracts/src/index";

test("shows a usage backend outage while retaining values and running the clock", async ({
  page,
}) => {
  const data = emptyDashboard();
  data.usageConnection = "unavailable";
  data.usageDelivery = {
    schemaVersion: 1,
    streamId: "outage-fixture",
    revision: "2",
    publishedAt: new Date().toISOString(),
  };
  Object.assign(data.usage[0], {
    ...emptyCommon("ok"),
    sourceAlias: "desk",
    receivedAt: new Date().toISOString(),
    buckets: [
      {
        id: "rate",
        label: "使用率",
        windows: [
          {
            id: "five",
            label: "5時間",
            usedPercent: 30,
            windowMinutes: 300,
            resetsAt: null,
          },
        ],
      },
    ],
  });
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/");
  await expect(
    page.getByText("usage提供サービスに未接続 · 最後の値を表示", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".usage-card progress").first()).toHaveAttribute(
    "value",
    "30",
  );
  const clock = page.getByTestId("clock-seconds");
  const before = await clock.textContent();
  await expect
    .poll(() => clock.textContent(), { timeout: 4000 })
    .not.toBe(before);
});

test("six provider cards preserve missing, quota and balance semantics at tablet and narrow widths", async ({
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
  Object.assign(
    data.usage.find((u) => u.provider === "grok")!,
    {
      ...emptyCommon("missing"),
      receivedAt: now,
      sourceAlias: "fixture-grok-source",
    },
  );
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: data }),
  );
  await page.goto("/");
  await expect(page.locator(".usage-card")).toHaveCount(usageProviders.length);
  await expect(page.locator(".usage-card progress:visible")).toHaveCount(2);
  const nous = page.locator(".usage-card").filter({
    has: page.getByRole("heading", { name: /Hermes \/ Nous.*利用状況/ }),
  });
  await expect(nous).toContainText("$37.00");
  await expect(nous.locator("progress")).toHaveCount(0);
  for (const [width, height] of [
    [1280, 800],
    [1280, 752],
    [960, 600],
    [800, 1280],
    [360, 800],
  ]) {
    await page.setViewportSize({ width, height });
    const usage = await page.locator(".usage-grid").boundingBox();
    const rss = await page.locator(".rss-card").boundingBox();
    const last = await page.locator(".usage-card").last().boundingBox();
    expect(usage && rss && last).toBeTruthy();
    if (!usage || !rss || !last) throw new Error("Missing provider layout");
    expect(rss.y).toBeGreaterThanOrEqual(usage.y + usage.height);
    if (width > height) {
      for (const card of await page.locator(".usage-card").all()) {
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(Math.abs(bounds!.y - usage.y)).toBeLessThan(1);
      }
      expect(last.width).toBeLessThan(usage.width / 4);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight + 1,
        ),
      ).toBe(true);
    } else {
      // Portrait retains a wrapping provider grid, including its final row.
      const previous = await page.locator(".usage-card").nth(4).boundingBox();
      expect(previous).not.toBeNull();
      if (!previous) throw new Error("Missing previous provider card");
      const paired = Math.abs(previous.y - last.y) < 1;
      if (paired) {
        // Two-column wrap: the final row must be a matched pair.
        expect(Math.abs(previous.width - last.width)).toBeLessThan(0.5);
      } else {
        // Single column: the final card spans the full grid width.
        expect(Math.abs(last.width - usage.width)).toBeLessThan(1);
      }
    }
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
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "時計・音声", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "利用状況", exact: true }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(6);
    await page.getByRole("button", { name: "時計に戻る" }).click();
    await expect(
      page.getByRole("button", { name: "設定", exact: true }),
    ).toBeFocused();
    await expect(page.locator(".usage-card")).toHaveCount(6);
  }
});

test("unconfigured extra providers leave two cards above the full-width RSS row", async ({
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
  expect(rss.y).toBeGreaterThanOrEqual(usage.y + usage.height);
  expect(Math.abs(rss.x - usage.x)).toBeLessThan(1);
  expect(Math.abs(rss.width - usage.width)).toBeLessThan(1);
});
