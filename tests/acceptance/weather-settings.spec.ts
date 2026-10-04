import { test, expect } from "@playwright/test";
import { emptyWeather } from "../../packages/contracts/src/index";
import {
  closeSettings,
  nativeHistory,
  openSettings,
  selection,
  setupSettings,
} from "./settings-fixture";

test.use({ serviceWorkers: "block" });
async function openWeather(page: import("@playwright/test").Page) {
  await openSettings(page, true);
  await expect(
    page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
  ).toBeEnabled();
}

test("admin acknowledgement stays in weather; explicit close and reopen read persisted state", async ({
  page,
  context,
}) => {
  const fixture = await setupSettings(page);
  const url = page.url();
  await openWeather(page);
  await page
    .getByRole("combobox", { name: "気温の代表地点", exact: true })
    .selectOption("44133");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect(
    page.getByRole("heading", { name: "天気・地域", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
  ).toHaveValue("44133");
  await closeSettings(page);
  await expect(
    page.getByRole("button", { name: "天気の地域を設定" }),
  ).toBeFocused();
  await expect(page.getByText("有効な予報を待っています")).toBeVisible();
  await openWeather(page);
  await expect(
    page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
  ).toHaveValue("44133");
  await page
    .getByRole("combobox", { name: "気温の代表地点", exact: true })
    .selectOption("44132");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect(fixture.puts).toEqual([
    { revision: "r1", selection: { ...selection, station: "44133" } },
    { revision: "r2", selection },
  ]);
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(1);
});

test("keyboard Cancel restores canonical draft in place; Return and Escape restore both openers", async ({
  page,
}) => {
  await setupSettings(page);
  const direct = page.getByRole("button", { name: "天気の地域を設定" });
  await direct.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "天気・地域", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("combobox", { name: "気温の代表地点", exact: true })
    .selectOption("44133");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(
    page.getByRole("heading", { name: "天気・地域", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
  ).toHaveValue("44132");
  await closeSettings(page);
  await expect(direct).toBeFocused();
  await openSettings(page);
  await page.getByRole("button", { name: "天気・地域", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "天気・地域", exact: true }),
  ).toBeFocused();
  await closeSettings(page);
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toBeFocused();
  await openWeather(page);
  await page.keyboard.press("Escape");
  await expect(direct).toBeFocused();
});

test("reader sees server labels with no catalog request or save controls", async ({
  page,
}) => {
  const fixture = await setupSettings(page, { canEdit: false });
  await openSettings(page, true);
  await expect(page.getByText(/変更には管理者権限/)).toBeVisible();
  await expect(page.getByText("東京地方", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  expect(fixture.requests.catalog).toBe(0);
  expect(fixture.puts).toHaveLength(0);
});

test("revision conflict requires explicit canonical reload and Cancel cannot bypass it", async ({
  page,
}) => {
  await setupSettings(page);
  let conflicted = false;
  let writes = 0;
  await page.route("**/api/v1/weather-settings", (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      conflicted = true;
      return route.fulfill({
        status: 409,
        json: { error: "revision_conflict" },
      });
    }
    if (!conflicted) return route.fallback();
    return route.fulfill({
      json: {
        revision: "r2",
        selection: { ...selection, station: "44133" },
        canEdit: true,
        weather: {
          ...emptyWeather(),
          configurationRevision: "r2",
          regionId: "130010",
          regionLabel: "東京地方",
          temperatureStationLabel: "八王子",
        },
      },
    });
  });
  await openWeather(page);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("別の画面");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("別の画面");
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "現在の設定を再読み込み" }).click();
  await expect(
    page.getByRole("combobox", { name: "気温の代表地点", exact: true }),
  ).toHaveValue("44133");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeEnabled();
});

test("pending save blocks section/header/Return/Escape/Back and duplicate submit until acknowledgement", async ({
  page,
  context,
}) => {
  await setupSettings(page);
  const url = page.url();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let writes = 0;
  await page.route("**/api/v1/weather-settings", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    writes++;
    await gate;
    return route.fulfill({
      json: {
        settings: { revision: "r2", selection },
        weather: {
          ...emptyWeather(),
          configurationRevision: "r2",
          status: "missing",
          regionId: "130010",
          regionLabel: "東京地方",
          temperatureStationLabel: "東京",
        },
      },
    });
  });
  await openWeather(page);
  try {
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "設定", exact: true }),
    ).toHaveAttribute("aria-busy", "true");
    for (const name of [
      "設定",
      "時計に戻る",
      "RSS",
      "利用状況",
      "天気・地域",
      "時計・音声",
      "キャンセル",
    ]) {
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    }
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await nativeHistory(page, "back", 2);
    await expect(
      page.getByRole("heading", { name: "天気・地域", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(writes).toBe(1);
  } finally {
    finish();
  }
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect(
    page.getByRole("heading", { name: "天気・地域", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "時計に戻る" })).toBeEnabled();
  await closeSettings(page);
  await expect(
    page.getByRole("button", { name: "天気の地域を設定" }),
  ).toBeFocused();
  expect(writes).toBe(1);
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(1);
});

test("lost save response explains possible persistence and prevents blind retry after Cancel", async ({
  page,
}) => {
  await setupSettings(page);
  let writes = 0;
  await page.route("**/api/v1/weather-settings", (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    writes++;
    return route.abort("failed");
  });
  await openWeather(page);
  await page
    .getByRole("combobox", { name: "気温の代表地点", exact: true })
    .selectOption("44133");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("保存された可能性");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("保存された可能性");
  await expect(
    page.getByRole("button", { name: "現在の設定を再読み込み" }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

test("permission loss reloads the canonical reader view without a second write or admin catalog", async ({
  page,
}) => {
  const fixture = await setupSettings(page);
  let forbidden = false;
  let writes = 0;
  await page.route("**/api/v1/weather-settings", (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      forbidden = true;
      return route.fulfill({ status: 403, json: { error: "forbidden" } });
    }
    return forbidden
      ? route.fulfill({
          json: {
            revision: "r2",
            selection,
            canEdit: false,
            weather: {
              ...emptyWeather(),
              configurationRevision: "r2",
              regionId: "130010",
              regionLabel: "東京地方",
              temperatureStationLabel: "東京",
            },
          },
        })
      : route.fallback();
  });
  await openWeather(page);
  await page
    .getByRole("combobox", { name: "気温の代表地点", exact: true })
    .selectOption("44133");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("管理者権限");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  const catalogBefore = fixture.requests.catalog;
  await page.getByRole("button", { name: "現在の設定を再読み込み" }).click();
  await expect(page.getByText(/この画面は現在の設定の確認のみ/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  expect(fixture.requests.catalog).toBe(catalogBefore);
  expect(writes).toBe(1);
});
