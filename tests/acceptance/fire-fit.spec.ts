import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  emptyCommon,
  emptyDashboard,
  parseDashboard,
  parseSettings,
  usageProviders,
  type Dashboard,
} from "../../packages/contracts/src/index";

// These fixtures exercise the production UI and contract parser. Blocking service
// workers keeps a previously cached dashboard from bypassing the API fixtures.
test.use({ serviceWorkers: "block" });

const now = new Date("2026-10-02T12:34:56.000Z");
const stamp = now.toISOString();
const instant = (hours: number) =>
  new Date(now.getTime() + hours * 3_600_000).toISOString();
const landscapeSizes = [
  { width: 1280, height: 800 },
  { width: 1280, height: 752 },
  { width: 960, height: 600 },
];
const portraitSize = { width: 800, height: 1280 };

function configuredDashboard(providerCount: 2 | 5): Dashboard {
  const data = emptyDashboard();
  const fresh = {
    ...emptyCommon("ok"),
    receivedAt: stamp,
    capturedAt: stamp,
    sourceObservedAt: stamp,
    lastSuccessAt: stamp,
    freshness: "known" as const,
  };
  data.weather = {
    ...data.weather,
    ...fresh,
    regionId: "130010",
    regionLabel: "東京都 東京地方",
    temperatureStationLabel: "東京（気温の代表地点）",
    issuedAt: stamp,
    periods: Array.from({ length: 4 }, (_, index) => ({
      startsAt: instant(index * 6),
      endsAt: instant((index + 1) * 6),
      summary: index === 0 ? "晴れ時々くもり" : `詳細予報 ${index + 1}`,
      weatherCode: "101",
      temperatureMinC: 19 + index,
      temperatureMaxC: 27 + index,
      precipitationProbabilityPct: 20 + index * 10,
    })),
  };
  data.rss = [
    {
      ...fresh,
      id: "fit-feed",
      label: "画面サイズ確認用フィード",
      items: Array.from({ length: 8 }, (_, index) => ({
        id: `headline-${index}`,
        title:
          index === 0
            ? "地域の天気と今日のニュースを確認するための長い見出し。画面幅を超えて他のカードを押し広げないことを確認します"
            : `詳細で読めるニュース ${index + 1}`,
        url: `https://example.com/news/${index}`,
        publishedAt: stamp,
        sourceLabel: "確認用ニュース",
      })),
    },
  ];
  data.usage = data.usage.map((value, index) => {
    if (index >= providerCount) return value;
    const configured = {
      ...value,
      ...fresh,
      sourceAlias: `fixture-${value.provider}-source`,
    };
    if (value.provider === "hermes_nous") {
      return {
        ...configured,
        balance: {
          currency: "USD" as const,
          subscriptionRemaining: 25,
          purchasedRemaining: 12,
          totalRemaining: 37,
          monthlyAllowance: 20,
          renewsAt: instant(24),
        },
      };
    }
    return {
      ...configured,
      buckets: Array.from({ length: 2 }, (_, bucket) => ({
        id: `bucket-${bucket}`,
        label: `長い名前の利用枠 ${bucket + 1}`,
        windows: Array.from({ length: 4 }, (_, window) => ({
          id: `window-${window}`,
          label: `利用期間と集計対象を説明する長いラベル ${window + 1}`,
          usedPercent: [42, 77, 0, 100][index],
          windowMinutes: (window + 1) * 300,
          resetsAt: instant(window + 1),
        })),
      })),
    };
  });
  return parseDashboard(data);
}

function errorDashboard(): Dashboard {
  const data = configuredDashboard(5);
  data.weather = {
    ...data.weather,
    status: "error",
    errorCode: "network",
    periods: [],
  };
  data.rss = data.rss.map((feed) => ({
    ...feed,
    status: "error",
    errorCode: "timeout",
    items: [],
  }));
  data.usage = data.usage.map((usage, index) => ({
    ...usage,
    status: "error",
    errorCode: index === 0 ? "auth" : "network",
    buckets: [],
    balance: undefined,
  }));
  return parseDashboard(data);
}

async function showDashboard(page: Page, data: Dashboard) {
  await page.clock.setFixedTime(now);
  await page.addInitScript(
    (settings) => {
      localStorage.setItem(
        "fire-dashboard-settings-v1",
        JSON.stringify(settings),
      );
    },
    parseSettings({ rssAutoRotate: false, timeZone: "UTC" }),
  );
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: data }),
  );
  await page.route("**/audio/manifest.json", (route) =>
    route.fulfill({ json: { hours: {}, chime: null } }),
  );
  await page.goto("/");
  await expect(page.getByText("集約サービス接続済み")).toBeVisible();
  await settleLayout(page);
}

async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Let ResizeObserver-driven clock sizing commit before measuring geometry.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function resize(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await settleLayout(page);
}

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

async function expectNoDocumentOverflow(page: Page, vertical = true) {
  const overflow = await page.evaluate(() => ({
    horizontal:
      Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - innerWidth,
    vertical:
      Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ) - innerHeight,
    x: scrollX,
    y: scrollY,
  }));
  expect(
    overflow.horizontal,
    "the dashboard must not scroll horizontally",
  ).toBeLessThanOrEqual(1);
  if (vertical) {
    expect(
      overflow.vertical,
      "the landscape dashboard must not scroll vertically",
    ).toBeLessThanOrEqual(1);
    expect(overflow.y).toBe(0);
  }
  expect(overflow.x).toBe(0);
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const bounds = await box(locator);
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.y).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectNoOverlap(
  first: Locator,
  second: Locator,
  message: string,
) {
  const a = await box(first);
  const b = await box(second);
  const overlapWidth =
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapHeight =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  expect(overlapWidth <= 1 || overlapHeight <= 1, message).toBe(true);
}

// A visible element can still have clipped digits. Measure actual text ranges
// against the viewport and every clipping ancestor, including overflow:hidden.
async function expectUnclippedText(page: Page, locator: Locator) {
  await expectInsideViewport(page, locator);
  const clipped = await locator.evaluate((element) => {
    const issues: string[] = [];
    const card = element.closest(".detail-content")
      ? null
      : element.closest(".card, .clock-panel")?.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let ranges = 0;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const parent = node.parentElement!;
      if (getComputedStyle(parent).visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height) continue;
        ranges++;
        const label = node.textContent!.trim();
        if (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1
        )
          issues.push(`${label}: outside viewport`);
        if (
          card &&
          (rect.left < card.left - 1 ||
            rect.top < card.top - 1 ||
            rect.right > card.right + 1 ||
            rect.bottom > card.bottom + 1)
        )
          issues.push(`${label}: outside its card`);
        for (
          let ancestor: HTMLElement | null = parent;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          const bounds = ancestor.getBoundingClientRect();
          const left = bounds.left + ancestor.clientLeft;
          const top = bounds.top + ancestor.clientTop;
          if (
            /(hidden|clip|auto|scroll)/.test(style.overflowX) &&
            (rect.left < left - 1 ||
              rect.right > left + ancestor.clientWidth + 1)
          )
            issues.push(
              `${label}: horizontally clipped by ${ancestor.className || ancestor.tagName}`,
            );
          if (
            /(hidden|clip|auto|scroll)/.test(style.overflowY) &&
            (rect.top < top - 1 ||
              rect.bottom > top + ancestor.clientHeight + 1)
          )
            issues.push(
              `${label}: vertically clipped by ${ancestor.className || ancestor.tagName}`,
            );
        }
      }
    }
    if (!ranges) issues.push("No rendered text ranges");
    return issues;
  });
  expect(
    clipped,
    `main value must be fully readable: ${await locator.textContent()}`,
  ).toEqual([]);
}

async function expectLandscapeLayout(page: Page, count: number) {
  await expect(page.locator(".usage-card")).toHaveCount(count);
  await expectNoDocumentOverflow(page);
  const top = await box(page.locator(".top-grid"));
  const clock = await box(page.locator(".clock-panel"));
  const weather = await box(page.locator(".weather-card"));
  const usage = await box(page.locator(".usage-grid"));
  const rss = await box(page.locator(".rss-card"));
  expect(weather.x).toBeGreaterThanOrEqual(clock.x + clock.width - 1);
  expect(Math.abs(weather.y - clock.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(weather.height - clock.height)).toBeLessThanOrEqual(1);
  expect(usage.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  expect(rss.y).toBeGreaterThanOrEqual(usage.y + usage.height - 1);
  expect(Math.abs(rss.x - usage.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(rss.width - usage.width)).toBeLessThanOrEqual(1);
  const clockFraction = clock.width / (clock.width + weather.width);
  expect(
    clockFraction,
    "the clock keeps approximately 70–75% of the upper area width",
  ).toBeGreaterThanOrEqual(0.69);
  expect(clockFraction).toBeLessThanOrEqual(0.76);
  let previousRight = usage.x;
  for (const card of await page.locator(".usage-card").all()) {
    const bounds = await box(card);
    expect(
      Math.abs(bounds.y - usage.y),
      "all providers share one row",
    ).toBeLessThanOrEqual(1);
    expect(bounds.x).toBeGreaterThanOrEqual(previousRight - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      usage.x + usage.width + 1,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      usage.y + usage.height + 1,
    );
    previousRight = bounds.x + bounds.width;
    await expectInsideViewport(page, card);
  }
  await expectInsideViewport(page, page.locator(".rss-card"));
  await expectUnclippedText(page, page.locator(".clock-hours"));
  await expectUnclippedText(page, page.locator(".clock-minutes"));
  await expectUnclippedText(page, page.getByTestId("clock-seconds"));
  for (const label of [
    page.locator(".clock-panel > .eyebrow"),
    page.locator(".clock-date"),
  ]) {
    await expectNoOverlap(
      page.getByTestId("clock-time"),
      label,
      "clock digits must not overlap the date or local-time label",
    );
    await expectNoOverlap(
      page.getByTestId("clock-seconds"),
      label,
      "seconds must not overlap the date or local-time label",
    );
  }
  for (const locator of [
    page.locator(".dashboard > header"),
    page.locator(".control-strip"),
    page.locator(".dashboard > footer"),
  ])
    await expectInsideViewport(page, locator);
}

async function tabTo(page: Page, target: Locator) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      await target.evaluate((element) => document.activeElement === element)
    ) {
      await expect(target).toBeFocused();
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `Control was not reachable by Tab: ${await target.textContent()}`,
  );
}

async function expectDayperiodWithinClock(page: Page) {
  const dayperiod = page.locator(".dayperiod");
  await expect(dayperiod).toHaveText("午後");
  await expectUnclippedText(page, dayperiod);
  const bounds = await box(dayperiod);
  const clock = await box(page.locator(".clock-panel"));
  expect(bounds.x).toBeGreaterThanOrEqual(clock.x);
  expect(bounds.y).toBeGreaterThanOrEqual(clock.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(clock.x + clock.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(clock.y + clock.height);
  for (const sibling of [
    page.locator(".clock-panel > .eyebrow"),
    page.getByTestId("clock-time"),
    page.getByTestId("clock-seconds"),
  ]) {
    await expectNoOverlap(
      dayperiod,
      sibling,
      "AM/PM must not overlap the clock label or digits",
    );
  }
}

for (const viewport of landscapeSizes) {
  test.describe(`Fire landscape ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    for (const count of [2, 5] as const) {
      test(`${count} configured providers fit one row beneath the clock and weather`, async ({
        page,
      }) => {
        await showDashboard(page, configuredDashboard(count));
        await expectLandscapeLayout(page, count);
        await expect(page.locator(".headline-preview article")).toHaveCount(1);
        await expect(page.locator(".rss-card article:visible")).toHaveCount(1);
        await expect(page.locator("details.card-details[open]")).toHaveCount(0);
        await expectUnclippedText(
          page,
          page.locator(".weather-card > .forecast"),
        );
        await expect(page.locator(".usage-overview")).toHaveCount(count);
        const primaryValues = page.locator(".usage-overview .usage-value");
        expect(await primaryValues.count()).toBeGreaterThanOrEqual(count);
        for (const value of await primaryValues.all()) {
          await expectUnclippedText(page, value);
        }
        if (count === 5) {
          const nous = page
            .locator(".usage-card")
            .filter({ hasText: "Hermes / Nous" });
          await expect(
            nous.locator(".usage-overview .usage-value"),
          ).toContainText("$37.00");
          await expect(nous.getByRole("progressbar")).toHaveCount(0);
        }
      });
    }

    test("unconfigured cards fit without invented usage or headlines", async ({
      page,
    }) => {
      await showDashboard(page, emptyDashboard());
      await expectLandscapeLayout(page, 2);
      await expect(page.getByText("地域未設定")).toBeVisible();
      await expect(page.getByText("フィード未登録")).toBeVisible();
      await expect(page.locator(".usage-card progress")).toHaveCount(0);
      await expect(page.locator(".rss-card article")).toHaveCount(0);
      await expect(page.locator(".usage-overview .usage-value")).toHaveCount(2);
      for (const value of await page
        .locator(".usage-overview .usage-value")
        .all()) {
        await expect(value).toContainText("—");
        await expectUnclippedText(page, value);
      }
    });

    test("five error states remain readable without pushing RSS off screen", async ({
      page,
    }) => {
      await showDashboard(page, errorDashboard());
      await expectLandscapeLayout(page, 5);
      const first = page.locator(".usage-card").first();
      await expect(first.locator(".status")).toHaveText("認証を確認");
      await expect(page.locator(".weather-card .status")).toHaveText(
        "取得エラー",
      );
      await expect(page.locator(".rss-card > .status")).toHaveText(
        "取得エラー",
      );
      await expect(page.locator(".usage-card progress")).toHaveCount(0);
      for (const card of await page.locator(".usage-card").all()) {
        await expectUnclippedText(page, card.locator(".status"));
        await expectUnclippedText(
          page,
          card.locator(".usage-overview .usage-value"),
        );
      }
    });
  });
}

test.describe("Fire portrait", () => {
  test.use({ viewport: portraitSize });
  for (const count of [2, 5] as const) {
    test(`${count} configured providers keep HH and MM stacked at 800×1280`, async ({
      page,
    }) => {
      await showDashboard(page, configuredDashboard(count));
      await expect(page.locator(".usage-card")).toHaveCount(count);
      const hours = await box(page.locator(".clock-hours"));
      const minutes = await box(page.locator(".clock-minutes"));
      expect(minutes.y).toBeGreaterThanOrEqual(hours.y + hours.height - 1);
      expect(
        Math.abs(hours.x + hours.width / 2 - minutes.x - minutes.width / 2),
      ).toBeLessThanOrEqual(1);
      await expectUnclippedText(page, page.locator(".clock-hours"));
      await expectUnclippedText(page, page.locator(".clock-minutes"));
      await expectNoDocumentOverflow(page, false);
    });
  }
  for (const state of ["unconfigured", "error"] as const) {
    test(`${state} cards keep the portrait clock readable`, async ({
      page,
    }) => {
      await showDashboard(
        page,
        state === "unconfigured" ? emptyDashboard() : errorDashboard(),
      );
      await expect(page.locator(".usage-card")).toHaveCount(
        state === "unconfigured" ? 2 : 5,
      );
      const hours = await box(page.locator(".clock-hours"));
      const minutes = await box(page.locator(".clock-minutes"));
      expect(minutes.y).toBeGreaterThanOrEqual(hours.y + hours.height - 1);
      await expectUnclippedText(page, page.locator(".clock-hours"));
      await expectUnclippedText(page, page.locator(".clock-minutes"));
      await expectNoDocumentOverflow(page, false);
    });
  }
});

test("keyboard details expose complete metadata without enlarging the 960×600 dashboard", async ({
  page,
}) => {
  await resize(page, landscapeSizes[2]);
  await showDashboard(page, configuredDashboard(5));
  const originalUsage = await box(page.locator(".usage-grid"));
  const originalRss = await box(page.locator(".rss-card"));
  const cards = [
    page.locator(".weather-card"),
    page.locator(".usage-card").first(),
    page.locator(".rss-card"),
  ];
  for (const card of cards) {
    const details = card.locator("details.card-details");
    const summary = details.locator("summary");
    await tabTo(page, summary);
    await page.keyboard.press("Enter");
    await expect(details).toHaveJSProperty("open", true);
    await expectInsideViewport(page, details.locator(".detail-content"));
    await expect(details.locator(".card-meta")).toContainText(
      /発表|最終受信|取得/,
    );
    await expectNoDocumentOverflow(page);
    expect(await box(page.locator(".usage-grid"))).toEqual(originalUsage);
    expect(await box(page.locator(".rss-card"))).toEqual(originalRss);
    await page.keyboard.press("Escape");
    await expect(details).toHaveJSProperty("open", false);
    await expect(summary).toBeFocused();
  }

  const weatherDetails = page.locator(".weather-card details.card-details");
  await expect(weatherDetails.locator(".forecast")).toHaveCount(4);
  await expect(weatherDetails.locator(".detail-content")).toContainText(
    "東京（気温の代表地点）",
  );
  const usageDetails = page
    .locator(".usage-card")
    .first()
    .locator("details.card-details");
  await tabTo(page, usageDetails.locator("summary"));
  await page.keyboard.press("Enter");
  await expect(usageDetails.locator(".usage-window")).toHaveCount(8);
  const source = usageDetails.getByText("fixture-claude-source", {
    exact: true,
  });
  await source.scrollIntoViewIfNeeded();
  await expectUnclippedText(page, source);
  await expectNoDocumentOverflow(page);
  await page.keyboard.press("Escape");
  await expect(usageDetails).toHaveJSProperty("open", false);

  const rssDetails = page.locator(".rss-card details.card-details");
  const rssSummary = rssDetails.locator("summary");
  await tabTo(page, rssSummary);
  await page.keyboard.press("Space");
  await expect(rssDetails).toHaveJSProperty("open", true);
  await expect(rssDetails.locator("article")).toHaveCount(8);
  const lastHeadline = rssDetails.getByRole("link", {
    name: "詳細で読めるニュース 8",
  });
  await tabTo(page, lastHeadline);
  await expectUnclippedText(page, lastHeadline);
  await expectNoDocumentOverflow(page);
  await page.keyboard.press("Escape");
  await expect(rssDetails).toHaveJSProperty("open", false);
});

test.describe("Fire touch details", () => {
  test.use({ hasTouch: true });
  test("a tapped usage detail remains bounded while the viewport resizes", async ({
    page,
  }) => {
    await resize(page, landscapeSizes[0]);
    await showDashboard(page, configuredDashboard(5));
    const details = page
      .locator(".usage-card")
      .first()
      .locator("details.card-details");
    const summary = details.locator("summary");
    await summary.tap();
    await expect(details).toHaveJSProperty("open", true);
    await expect(details.locator(".detail-content")).toContainText(
      "fixture-claude-source",
    );
    await expect(details.locator(".usage-window")).toHaveCount(8);
    for (const viewport of landscapeSizes) {
      await resize(page, viewport);
      await expectInsideViewport(page, details.locator(".detail-content"));
      await expectNoDocumentOverflow(page);
    }
    // A visible close control must also work without a hardware keyboard.
    await details.getByRole("button", { name: "詳細を閉じる" }).tap();
    await expect(details).toHaveJSProperty("open", false);
    await expectLandscapeLayout(page, 5);
  });
});

test("settings remain keyboard usable and the dashboard reflows after rotation", async ({
  page,
}) => {
  await resize(page, landscapeSizes[2]);
  await showDashboard(page, configuredDashboard(5));
  await tabTo(page, page.getByRole("button", { name: "設定", exact: true }));
  await page.keyboard.press("Enter");
  const hour12 = page.getByRole("checkbox", { name: "12時間表記" });
  await tabTo(page, hour12);
  await page.keyboard.press("Space");
  await expect(hour12).toBeChecked();
  await tabTo(page, page.getByRole("button", { name: "時計に戻る" }));
  await page.keyboard.press("Enter");
  await expectLandscapeLayout(page, 5);
  await expectDayperiodWithinClock(page);

  await resize(page, portraitSize);
  const hours = await box(page.locator(".clock-hours"));
  const minutes = await box(page.locator(".clock-minutes"));
  expect(minutes.y).toBeGreaterThanOrEqual(hours.y + hours.height - 1);
  await expectUnclippedText(page, page.locator(".clock-hours"));
  await expectUnclippedText(page, page.locator(".clock-minutes"));
  await expectNoDocumentOverflow(page, false);
  for (const viewport of landscapeSizes) {
    await resize(page, viewport);
    await expectLandscapeLayout(page, 5);
    await expectDayperiodWithinClock(page);
    const landscapeHours = await box(page.locator(".clock-hours"));
    const landscapeMinutes = await box(page.locator(".clock-minutes"));
    expect(Math.abs(landscapeHours.y - landscapeMinutes.y)).toBeLessThanOrEqual(
      1,
    );
    expect(landscapeMinutes.x).toBeGreaterThan(landscapeHours.x);
  }
  await expect(page.locator(".usage-card")).toHaveCount(usageProviders.length);
});
