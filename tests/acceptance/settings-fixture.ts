import { expect, type Locator, type Page } from "@playwright/test";
import {
  emptyCommon,
  emptyDashboard,
  emptyWeather,
  parseDashboard,
  parseSettings,
  weatherSettingsStateSchema,
  type Dashboard,
  type WeatherSelection,
  type WeatherSettingsState,
} from "../../packages/contracts/src/index";

export const settingsKey = "fire-dashboard-settings-v1";
export const fixtureTime = new Date("2026-10-04T12:34:56.000Z");
export const selection: WeatherSelection = {
  office: "130000",
  region: "130010",
  station: "44132",
};
export const providerLabels = [
  "Claude",
  "Codex",
  "Google AI（Antigravity）",
  "OpenCode Go",
  "Hermes / Nous",
  "Grok",
];
export const longRegion =
  "東京地方・多摩西部・伊豆諸島北部を含む長い予報地域の表示確認".repeat(3);
export const longStation =
  "山間部と離島を含む非常に長い気温代表地点の表示確認".repeat(3);
export const fixtureLicense =
  "DSEG acceptance fixture\n" + "Long license line ".repeat(100);
export const initialSettings = parseSettings({
  timeZone: "UTC",
  hour12: true,
  audioMode: "voice",
  volume: 0.7,
  quiet: { enabled: true, start: "23:00", end: "06:00" },
  rssAutoRotate: false,
});

type InstrumentedWindow = Window & {
  acceptanceAudioPlays: number;
  acceptancePopstates: number;
};

/** Local, synthetic API only. No account, authorization or collector is changed. */
export async function setupSettings(
  page: Page,
  { canEdit = true, longLabels = false, configuredForecast = false } = {},
) {
  await page.clock.setFixedTime(fixtureTime);
  await page.addInitScript(
    ({ key, settings }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(settings));
      const instrumented = window as unknown as InstrumentedWindow;
      instrumented.acceptanceAudioPlays = 0;
      instrumented.acceptancePopstates = 0;
      window.addEventListener(
        "popstate",
        () => instrumented.acceptancePopstates++,
      );
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        instrumented.acceptanceAudioPlays++;
        return play.call(this);
      };
    },
    { key: settingsKey, settings: initialSettings },
  );
  let revision = "r1";
  let currentSelection: WeatherSelection | null = selection;
  const puts: WeatherSettingsState[] = [];
  const requests = { dashboard: 0, catalog: 0, settings: 0 };
  const office = {
    office: { id: "130000", label: "東京都" },
    regions: [{ id: "130010", label: longLabels ? longRegion : "東京地方" }],
    stations: [
      { id: "44132", label: longLabels ? longStation : "東京" },
      { id: "44133", label: "八王子" },
    ],
  };
  const weather = () => ({
    ...emptyWeather(),
    configurationRevision: revision,
    regionId: currentSelection?.region ?? null,
    regionLabel: currentSelection ? office.regions[0].label : null,
    temperatureStationLabel: currentSelection
      ? office.stations.find(
          (station) => station.id === currentSelection?.station,
        )!.label
      : null,
    status: currentSelection ? ("missing" as const) : ("unconfigured" as const),
    ...(configuredForecast && currentSelection
      ? {
          ...common,
          issuedAt: fixtureTime.toISOString(),
          periods: Array.from({ length: 4 }, (_, index) => ({
            startsAt: new Date(
              fixtureTime.getTime() + index * 6 * 3_600_000,
            ).toISOString(),
            endsAt: new Date(
              fixtureTime.getTime() + (index + 1) * 6 * 3_600_000,
            ).toISOString(),
            summary: index === 0 ? "晴れ時々くもり" : `詳細予報 ${index + 1}`,
            weatherCode: "101",
            temperatureMinC: 19,
            temperatureMaxC: 27,
            precipitationProbabilityPct: 20,
          })),
        }
      : {}),
  });
  const common = {
    ...emptyCommon("ok"),
    receivedAt: fixtureTime.toISOString(),
    sourceObservedAt: fixtureTime.toISOString(),
    capturedAt: fixtureTime.toISOString(),
    lastSuccessAt: fixtureTime.toISOString(),
    freshness: "known" as const,
  };
  const data = parseDashboard({
    ...emptyDashboard(),
    weather: weather(),
    usage: emptyDashboard().usage.map((value) => ({
      ...value,
      ...common,
      sourceAlias: `acceptance-${value.provider}`,
      buckets: [
        {
          id: "quota",
          label: "Synthetic usage",
          windows: [
            {
              id: "quota",
              label: "Synthetic window",
              usedPercent: 37,
              resetsAt: null,
              windowMinutes: null,
            },
          ],
        },
      ],
    })),
    rss: [
      {
        ...common,
        id: "local-fixture",
        label: "現在のRSS名称・購読元ホストは提供されていません",
        items: [
          {
            id: "headline",
            title: "ローカル受入試験用ニュース",
            url: "https://example.com/article",
            publishedAt: fixtureTime.toISOString(),
            sourceLabel: "Synthetic source",
          },
        ],
      },
    ],
  });
  let usage = data.usage;
  await page.route("**/api/v1/dashboard", (route) => {
    requests.dashboard++;
    return route.fulfill({ json: { ...data, usage, weather: weather() } });
  });
  await page.route("**/api/v1/weather-catalog*", (route) => {
    requests.catalog++;
    return route.fulfill({
      json: new URL(route.request().url()).searchParams.has("office")
        ? office
        : { offices: [office.office] },
    });
  });
  await page.route("**/api/v1/weather-settings", (route) => {
    requests.settings++;
    if (route.request().method() === "PUT") {
      const body = weatherSettingsStateSchema.parse(
        route.request().postDataJSON(),
      );
      puts.push(body);
      currentSelection = body.selection;
      revision = `r${puts.length + 1}`;
      return route.fulfill({
        json: {
          settings: { revision, selection: currentSelection },
          weather: weather(),
        },
      });
    }
    return route.fulfill({
      json: {
        revision,
        selection: currentSelection,
        canEdit,
        weather: weather(),
      },
    });
  });
  await page.route("**/licenses/DSEG-LICENSE.txt", (route) =>
    route.fulfill({ contentType: "text/plain", body: fixtureLicense }),
  );
  await page.goto("/");
  await expect(page.getByText("集約サービス接続済み")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  return {
    data,
    puts,
    requests,
    setUsage(next: Dashboard["usage"]) {
      usage = parseDashboard({ ...data, usage: next }).usage;
    },
  };
}

export async function openSettings(page: Page, weather = false) {
  await page
    .getByRole("button", {
      name: weather ? "天気の地域を設定" : "設定",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: weather ? "天気・地域" : "時計・音声",
      exact: true,
    }),
  ).toBeFocused();
}

export async function expectWeatherShortcutContained(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  const card = page.locator(".weather-card");
  const button = card.getByRole("button", {
    name: "天気の地域を設定",
    exact: true,
  });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  const cardBounds = await card.boundingBox();
  const buttonBounds = await button.boundingBox();
  expect(cardBounds).not.toBeNull();
  expect(buttonBounds).not.toBeNull();
  expect(buttonBounds!.height).toBeGreaterThanOrEqual(44);
  expect(buttonBounds!.width).toBeGreaterThanOrEqual(44);
  for (const locator of [
    card.locator(".card-heading"),
    card.getByRole("heading"),
    card.locator(".status"),
    card.locator(":scope > .forecast, :scope > p"),
    button,
    card.locator("details > summary"),
  ]) {
    await expect(locator).toBeVisible();
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(cardBounds!.x - 1);
    expect(bounds!.y).toBeGreaterThanOrEqual(cardBounds!.y - 1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
      cardBounds!.x + cardBounds!.width + 1,
    );
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
      cardBounds!.y + cardBounds!.height + 1,
    );
  }
  const viewport = page.viewportSize()!;
  if (viewport.width > viewport.height) {
    expect(cardBounds!.x).toBeGreaterThanOrEqual(0);
    expect(cardBounds!.y).toBeGreaterThanOrEqual(0);
    expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(
      viewport.width + 1,
    );
    expect(cardBounds!.y + cardBounds!.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );
    const heading = card.getByRole("heading");
    const headingBounds = await heading.boundingBox();
    const lineHeight = await heading.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(headingBounds!.height).toBeLessThanOrEqual(lineHeight + 1);
    const status = card.locator(".status");
    const statusBounds = await status.boundingBox();
    const singleLineHeight = await status.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.lineHeight,
        style.paddingTop,
        style.paddingBottom,
        style.borderTopWidth,
        style.borderBottomWidth,
      ].reduce((height, value) => height + Number.parseFloat(value), 0);
    });
    expect(statusBounds!.height).toBeLessThanOrEqual(singleLineHeight + 1);
  }
  // Playwright checks real hit testing; the caller then clicks normally to open.
  await button.click({ trial: true });
}

export async function closeSettings(page: Page) {
  const back = page.getByRole("button", { name: "時計に戻る" });
  await expect(back).toBeEnabled();
  await back.click();
  await expect(
    page.getByRole("region", { name: "設定", exact: true }),
  ).toHaveCount(0);
}

export async function nativeHistory(
  page: Page,
  direction: "back" | "forward",
  events = 1,
) {
  const before = await page.evaluate(
    () => (window as unknown as InstrumentedWindow).acceptancePopstates,
  );
  await page.evaluate((direction) => window.history[direction](), direction);
  // Wait for real browser traversal(s), including a guarded Back's restoration.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as InstrumentedWindow).acceptancePopstates,
      ),
    )
    .toBeGreaterThanOrEqual(before + events);
}

export async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

export async function expectReadable(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const issues = await locator.evaluate((element) => {
    const errors: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let ranges = 0;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height) continue;
        ranges++;
        if (
          rect.left < -1 ||
          rect.right > innerWidth + 1 ||
          rect.top < -1 ||
          rect.bottom > innerHeight + 1
        )
          errors.push("outside viewport");
        for (
          let ancestor = node.parentElement;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          const bounds = ancestor.getBoundingClientRect();
          if (
            /(hidden|clip|auto|scroll)/.test(style.overflowX) &&
            (rect.left < bounds.left + ancestor.clientLeft - 1 ||
              rect.right >
                bounds.left + ancestor.clientLeft + ancestor.clientWidth + 1)
          )
            errors.push("horizontal clipping");
          if (
            /(hidden|clip|auto|scroll)/.test(style.overflowY) &&
            (rect.top < bounds.top + ancestor.clientTop - 1 ||
              rect.bottom >
                bounds.top + ancestor.clientTop + ancestor.clientHeight + 1)
          )
            errors.push("vertical clipping");
        }
      }
    }
    if (!ranges) errors.push("no rendered text");
    return errors;
  });
  expect(issues).toEqual([]);
}

export async function expectAudioStillDisabled(page: Page) {
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "音声を無効にする" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as InstrumentedWindow).acceptanceAudioPlays,
    ),
  ).toBe(0);
}
