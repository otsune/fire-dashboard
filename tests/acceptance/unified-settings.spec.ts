import { test, expect } from "@playwright/test";
import { formatTime } from "../../apps/dashboard/src/data/status";
import {
  closeSettings,
  expectAudioStillDisabled,
  expectNoHorizontalOverflow,
  expectReadable,
  expectWeatherShortcutContained,
  fixtureLicense,
  initialSettings,
  longRegion,
  longStation,
  nativeHistory,
  openSettings,
  providerLabels,
  selection,
  settingsKey,
  setupSettings,
} from "./settings-fixture";

// API routes must not be bypassed by a previously installed worker.
test.use({ serviceWorkers: "block" });
const viewports = [
  { width: 1280, height: 800 },
  { width: 1280, height: 752 },
  { width: 960, height: 600 },
  { width: 800, height: 1280 },
];

for (const viewport of viewports) {
  test.describe(`Unified settings ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("four sections, readable RSS and in-app license stay in one document", async ({
      page,
      context,
    }, testInfo) => {
      await setupSettings(page);
      const url = page.url();
      const historyLength = await page.evaluate(() => history.length);
      await expectWeatherShortcutContained(page);
      await openSettings(page);
      const nav = page.getByRole("navigation", { name: "設定の区分" });
      await expect(nav.getByRole("button")).toHaveCount(4);
      for (const name of ["RSS", "利用状況", "天気・地域", "時計・音声"]) {
        await nav.getByRole("button", { name, exact: true }).click();
        await expect(
          page.getByRole("heading", { name, exact: true }),
        ).toBeFocused();
        await expect(
          nav.getByRole("button", { name, exact: true }),
        ).toHaveAttribute("aria-current", "page");
        if (name === "天気・地域")
          await expect(
            page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
          ).toBeEnabled();
        await expectNoHorizontalOverflow(page);
        for (const control of await nav.getByRole("button").all()) {
          const bounds = await control.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.height).toBeGreaterThanOrEqual(44);
        }
        await testInfo.attach(
          `settings-${name}-${viewport.width}x${viewport.height}`,
          {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          },
        );
      }
      await expect(page.locator(".settings-license pre")).toHaveText(
        fixtureLicense,
      );
      await expect(page.locator(".settings-license a")).toHaveCount(0);
      await page.locator(".settings-license pre").scrollIntoViewIfNeeded();
      expect(
        await page
          .locator(".settings-license pre")
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      ).toBe(true);
      await nav.getByRole("button", { name: "RSS", exact: true }).click();
      await expectReadable(
        page,
        page.getByText("現在のRSS名称・購読元ホストは提供されていません", {
          exact: true,
        }),
      );
      await expect(
        page.getByRole("checkbox", { name: "RSSを15秒ごとに切り替える" }),
      ).not.toBeChecked();
      await expect(page.locator(".settings-status-list")).not.toContainText(
        "example.com",
      );
      await expect(
        page.getByRole("button", { name: /追加|編集|削除|並べ替え|保存/ }),
      ).toHaveCount(0);
      await closeSettings(page);
      await expect(
        page.getByRole("button", { name: "設定", exact: true }),
      ).toBeFocused();
      await expectAudioStillDisabled(page);
      expect(page.url()).toBe(url);
      expect(context.pages()).toHaveLength(1);
      expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
    });

    test("all six choices persist, all-off RSS fills its row, newer hidden usage returns before reload", async ({
      page,
      context,
    }) => {
      const fixture = await setupSettings(page);
      const url = page.url();
      const metadata = await page
        .locator('[data-provider="claude"] .card-meta')
        .textContent();
      await expect(page.locator(".usage-card")).toHaveCount(5);
      await openSettings(page);
      await page.getByRole("button", { name: "利用状況", exact: true }).click();
      await expect(page.getByRole("checkbox")).toHaveCount(6);
      await expect(
        page.getByText("未接続・接続後に表示", { exact: true }),
      ).toBeVisible();
      for (const label of providerLabels) {
        const checkbox = page.getByRole("checkbox", {
          name: `${label}を表示する`,
          exact: true,
        });
        const touchLabel = checkbox.locator("..");
        await expectReadable(page, touchLabel);
        const bounds = await touchLabel.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        await checkbox.uncheck();
      }
      await closeSettings(page);
      await expect(
        page.getByRole("region", { name: "AI利用状況" }),
      ).toHaveCount(0);
      await expect(page.locator(".usage-card")).toHaveCount(0);
      const parent = page.locator(".provider-layout");
      await expect(parent).toHaveClass(/usage-hidden/);
      const layout = await parent.boundingBox();
      const rss = await page.locator(".rss-card").boundingBox();
      expect(layout && rss).toBeTruthy();
      expect(Math.abs(rss!.x - layout!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(rss!.width - layout!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(rss!.y - layout!.y)).toBeLessThanOrEqual(1);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByTestId("clock-time")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "画面を点灯保持" }),
      ).toBeEnabled();
      await expectAudioStillDisabled(page);
      const newer = {
        sourceObservedAt: "2026-10-04T12:35:00.000Z",
        capturedAt: "2026-10-04T12:36:00.000Z",
        receivedAt: "2026-10-04T12:37:00.000Z",
        lastSuccessAt: "2026-10-04T12:37:00.000Z",
      };
      fixture.setUsage(
        fixture.data.usage.map((value) => ({
          ...value,
          ...newer,
          buckets: value.buckets.map((bucket) => ({
            ...bucket,
            windows: bucket.windows.map((window) => ({
              ...window,
              usedPercent: 64,
            })),
          })),
        })),
      );
      await page.clock.setFixedTime(new Date("2026-10-04T12:37:30.000Z"));
      const refreshed = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/dashboard") && response.ok(),
      );
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      expect(await (await refreshed).finished()).toBeNull();
      await expect(page.locator(".usage-card")).toHaveCount(0);
      await openSettings(page);
      await page.getByRole("button", { name: "利用状況", exact: true }).click();
      await page
        .getByRole("checkbox", { name: "Claudeを表示する", exact: true })
        .check();
      await closeSettings(page);
      await expect(page.locator(".usage-card")).toHaveCount(1);
      await expect(
        page.locator('[data-provider="claude"] .usage-overview strong'),
      ).toHaveText("64%");
      const refreshedMetadata = page.locator(
        '[data-provider="claude"] .card-meta',
      );
      await expect(refreshedMetadata).not.toHaveText(metadata!);
      for (const [label, timestamp] of [
        ["元データ観測", newer.sourceObservedAt],
        ["収集日時", newer.capturedAt],
        ["最終受信", newer.receivedAt],
        ["最終成功", newer.lastSuccessAt],
      ])
        await expect(refreshedMetadata).toContainText(
          `${label} ${formatTime(timestamp, initialSettings.timeZone)}`,
        );

      // Persistence is checked separately, after receipt/retention above has
      // already been proved without a reload supplying the payload afresh.
      await openSettings(page);
      await page.getByRole("button", { name: "利用状況", exact: true }).click();
      await page
        .getByRole("checkbox", { name: "Claudeを表示する", exact: true })
        .uncheck();
      await closeSettings(page);
      await page.reload();
      await expect(page.locator(".usage-card")).toHaveCount(0);
      await expectAudioStillDisabled(page);
      await openSettings(page);
      await page.getByRole("button", { name: "利用状況", exact: true }).click();
      for (const label of providerLabels)
        await expect(
          page.getByRole("checkbox", {
            name: `${label}を表示する`,
            exact: true,
          }),
        ).not.toBeChecked();
      const stored = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        settingsKey,
      );
      expect(stored).toEqual({
        ...initialSettings,
        usageVisibility: {
          claude: false,
          codex: false,
          antigravity: false,
          opencode_go: false,
          hermes_nous: false,
          grok: false,
        },
      });
      await closeSettings(page);
      await expect(page.locator(".usage-card")).toHaveCount(0);
      expect(fixture.puts).toHaveLength(0);
      expect(page.url()).toBe(url);
      expect(context.pages()).toHaveLength(1);
    });

    test("admin long labels and safe errors remain readable; acknowledgement stays in weather", async ({
      page,
      context,
    }, testInfo) => {
      const fixture = await setupSettings(page, { longLabels: true });
      const url = page.url();
      await expectWeatherShortcutContained(page);
      await openSettings(page, true);
      await expect(
        page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
      ).toBeEnabled();
      await expect(page.locator(".weather-current dd").first()).toHaveText(
        longRegion,
      );
      await expectReadable(page, page.locator(".weather-current dd").first());
      // Current labels are separate dd nodes; native select text can be elided.
      await expectReadable(page, page.locator(".weather-current dd").nth(1));
      await expect(page.locator(".weather-current dd").nth(1)).toHaveText(
        longStation,
      );
      await page
        .getByRole("combobox", { name: "気温の代表地点", exact: true })
        .selectOption("44133");
      const failSave = async (route: import("@playwright/test").Route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        return route.fulfill({
          status: 500,
          json: { error: "unconfirmed_fixture_response" },
        });
      };
      await page.route("**/api/v1/weather-settings", failSave);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("保存された可能性");
      await expectReadable(page, page.getByRole("alert"));
      await expect(
        page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
      ).toHaveValue("44133");
      await testInfo.attach(
        `long-label-error-${viewport.width}x${viewport.height}`,
        {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        },
      );
      await expect(
        page.getByRole("button", { name: "保存", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "現在の設定を再読み込み" })
        .click();
      await expect(
        page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
      ).toHaveValue("44132");
      await page
        .getByRole("combobox", { name: "気温の代表地点", exact: true })
        .selectOption("44133");
      await page.unroute("**/api/v1/weather-settings", failSave);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("保存しました");
      await expect(
        page.getByRole("heading", { name: "天気・地域", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "時計に戻る" }),
      ).toBeEnabled();
      expect(fixture.puts).toEqual([
        { revision: "r1", selection: { ...selection, station: "44133" } },
      ]);
      await closeSettings(page);
      await expect(
        page.getByRole("button", { name: "天気の地域を設定" }),
      ).toBeFocused();
      await openSettings(page, true);
      await expect(
        page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
      ).toHaveValue("44133");
      await closeSettings(page);
      await expectAudioStillDisabled(page);
      expect(page.url()).toBe(url);
      expect(context.pages()).toHaveLength(1);
    });

    test("viewer reads long server labels without catalog or save and can change local visibility", async ({
      page,
      context,
    }) => {
      const fixture = await setupSettings(page, {
        canEdit: false,
        longLabels: true,
      });
      const url = page.url();
      await expectWeatherShortcutContained(page);
      await openSettings(page, true);
      await expect(
        page.getByText(/この画面は現在の設定の確認のみ/),
      ).toBeVisible();
      await expectReadable(page, page.locator(".weather-current dd").first());
      await expectReadable(page, page.locator(".weather-current dd").nth(1));
      await expect(page.locator(".weather-current dd").first()).toHaveText(
        longRegion,
      );
      await expect(page.locator(".weather-current dd").nth(1)).toHaveText(
        longStation,
      );
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "保存", exact: true }),
      ).toHaveCount(0);
      expect(fixture.requests.catalog).toBe(0);
      await page.getByRole("button", { name: "利用状況", exact: true }).click();
      await page.getByRole("checkbox", { name: "Grokを表示する" }).uncheck();
      await closeSettings(page);
      await expectAudioStillDisabled(page);
      expect(fixture.puts).toHaveLength(0);
      expect(page.url()).toBe(url);
      expect(context.pages()).toHaveLength(1);
    });
  });
}

test.describe("Weather shortcut with configured forecast at 960×600", () => {
  test.use({ viewport: { width: 960, height: 600 } });
  for (const longLabels of [false, true]) {
    test(`${longLabels ? "long" : "short"} region stays inside the card and opens normally`, async ({
      page,
    }) => {
      await setupSettings(page, { longLabels, configuredForecast: true });
      const card = page.locator(".weather-card");
      const regionLabel = longLabels ? longRegion : "東京地方";
      await expect(
        card.getByRole("heading", { name: regionLabel, exact: true }),
      ).toHaveText(regionLabel);
      await expect(card.locator(":scope > .forecast")).toContainText(
        "晴れ時々くもり",
      );
      await expectWeatherShortcutContained(page);
      const details = card.locator("details");
      await details.locator("summary").click();
      await expect(details).toHaveJSProperty("open", true);
      await expect(
        details.getByText(`予報地方：${regionLabel}`, { exact: true }),
      ).toBeVisible();
      await expectReadable(
        page,
        details.getByText(`予報地方：${regionLabel}`, { exact: true }),
      );
      await expect(details.locator(".forecast")).toHaveCount(4);
      await expect(
        details.getByText("詳細予報 4", { exact: true }),
      ).toBeVisible();
      await details.getByRole("button", { name: "詳細を閉じる" }).click();
      await expect(details).toHaveJSProperty("open", false);
      await openSettings(page, true);
      await expect(page.locator(".weather-current dd").first()).toHaveText(
        regionLabel,
      );
      await closeSettings(page);
      await expect(
        page.getByRole("button", { name: "天気の地域を設定", exact: true }),
      ).toBeFocused();
    });
  }
});

test("native Back/Forward, Escape and dirty guards preserve draft and opener focus", async ({
  page,
  context,
}) => {
  const fixture = await setupSettings(page);
  const url = page.url();
  const initialLength = await page.evaluate(() => history.length);
  await openSettings(page);
  await page.getByRole("button", { name: "RSS", exact: true }).click();
  await nativeHistory(page, "back");
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toBeFocused();
  await nativeHistory(page, "forward");
  await expect(
    page.getByRole("heading", { name: "RSS", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toBeFocused();
  await openSettings(page, true);
  const station = page.getByRole("combobox", {
    name: "気温の代表地点",
    exact: true,
  });
  await station.selectOption("44133");
  await station.focus();
  await page.keyboard.press("Escape");
  const dialog = page.getByRole("alertdialog", { name: "未保存の変更" });
  await expect(dialog).toHaveCount(1);
  await expect(
    dialog.getByRole("button", { name: "編集を続ける" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "変更を破棄して移動" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "編集を続ける" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "変更を破棄して移動" }),
  ).toBeFocused();
  await dialog.getByRole("button", { name: "編集を続ける" }).click();
  await expect(station).toBeFocused();
  await expect(station).toHaveValue("44133");
  await nativeHistory(page, "back", 2);
  await expect(dialog).toHaveCount(1);
  await dialog.getByRole("button", { name: "編集を続ける" }).click();
  await expect(station).toHaveValue("44133");
  await page.getByRole("button", { name: "RSS", exact: true }).click();
  await dialog.getByRole("button", { name: "変更を破棄して移動" }).click();
  await expect(
    page.getByRole("heading", { name: "RSS", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "天気・地域", exact: true }).click();
  await expect(station).toHaveValue("44132");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "天気の地域を設定" }),
  ).toBeFocused();
  expect(fixture.puts).toHaveLength(0);
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(1);
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
});

test("license failure retries in app and clock/audio edits never enable playback", async ({
  page,
  context,
}) => {
  await setupSettings(page);
  const url = page.url();
  let attempts = 0;
  await page.route("**/licenses/DSEG-LICENSE.txt", (route) =>
    ++attempts === 1
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.fallback(),
  );
  await openSettings(page);
  await expect(page.getByRole("alert")).toContainText(
    "ライセンスを取得できません",
  );
  await page.getByRole("button", { name: "ライセンスを再読み込み" }).click();
  await expect(page.locator(".settings-license pre")).toHaveText(
    fixtureLicense,
  );
  await page.getByRole("checkbox", { name: "12時間表記" }).uncheck();
  await page.getByLabel("時報の種類").selectOption("both");
  const volume = page.getByRole("slider", { name: "アプリ内音量" });
  await volume.press("Home");
  await volume.press("ArrowRight");
  await expect(volume).toHaveValue("1");
  await closeSettings(page);
  await expectAudioStillDisabled(page);
  await page.reload();
  await expectAudioStillDisabled(page);
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(1);
});
