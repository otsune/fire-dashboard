import { test, expect, type Page } from "@playwright/test";
import {
  emptyDashboard,
  emptyWeather,
  type WeatherSelection,
} from "../../packages/contracts/src/index";
const selection = { office: "130000", region: "130010", station: "44132" };
const office = {
  office: { id: "130000", label: "東京都" },
  regions: [{ id: "130010", label: "東京地方" }],
  stations: [
    { id: "44132", label: "東京" },
    { id: "44133", label: "八王子" },
  ],
};
async function setup(page: Page, canEdit = true) {
  let revision = "r1",
    currentSelection: WeatherSelection | null = selection;
  const weather = () => ({
    ...emptyWeather(),
    configurationRevision: revision,
    regionId: currentSelection?.region ?? null,
    regionLabel: currentSelection ? "東京地方" : null,
    temperatureStationLabel: currentSelection
      ? currentSelection.station === "44133"
        ? "八王子"
        : "東京"
      : null,
    status: currentSelection ? ("missing" as const) : ("unconfigured" as const),
  });
  await page.route("**/api/v1/dashboard", (route) =>
    route.fulfill({ json: { ...emptyDashboard(), weather: weather() } }),
  );
  await page.route("**/api/v1/weather-catalog*", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.has("office")
        ? office
        : { offices: [office.office] },
    }),
  );
  await page.route("**/api/v1/weather-settings", (route) => {
    if (route.request().method() === "PUT") {
      currentSelection = route.request().postDataJSON().selection;
      revision = "r2";
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
  await page.goto("/");
}
async function open(page: Page) {
  await page.getByRole("button", { name: "天気の地域を設定" }).click();
  await expect(
    page.getByRole("heading", { name: "天気の地域設定" }),
  ).toBeFocused();
}
test("admin saves an explicit station in the same kiosk document and reopening reads persisted state", async ({
  page,
  context,
}) => {
  await setup(page);
  const url = page.url(),
    pages = context.pages().length;
  await open(page);
  await page
    .getByLabel("気温の代表地点", { exact: true })
    .selectOption("44133");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "天気の地域を設定" }),
  ).toBeFocused();
  await expect(page.getByText("有効な予報を待っています")).toBeVisible();
  await open(page);
  await expect(page.getByLabel("気温の代表地点", { exact: true })).toHaveValue(
    "44133",
  );
  expect(page.url()).toBe(url);
  expect(context.pages()).toHaveLength(pages);
});
test("keyboard Cancel, Back and Escape discard drafts and restore both entry points", async ({
  page,
}) => {
  await setup(page);
  const direct = page.getByRole("button", { name: "天気の地域を設定" });
  await direct.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "天気の地域設定" }),
  ).toBeFocused();
  await page
    .getByLabel("気温の代表地点", { exact: true })
    .selectOption("44133");
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(direct).toBeFocused();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await open(page);
  await expect(page.getByLabel("気温の代表地点", { exact: true })).toHaveValue(
    "44132",
  );
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "天気の地域を設定" }),
  ).toBeFocused();
  await open(page);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "天気の地域を設定" }),
  ).toBeFocused();
});
test("reader sees server labels with no catalog request or save controls", async ({
  page,
}) => {
  let catalogRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("weather-catalog")) catalogRequests++;
  });
  await setup(page, false);
  await open(page);
  await expect(page.getByText(/変更には管理者権限/)).toBeVisible();
  await expect(page.getByText("東京地方", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  expect(catalogRequests).toBe(0);
});
test("revision conflict requires explicit canonical reload", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/v1/weather-settings", (route) =>
    route.fulfill(
      route.request().method() === "PUT"
        ? { status: 409, json: { error: "revision_conflict" } }
        : {
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
          },
    ),
  );
  await open(page);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("別の画面");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "現在の設定を再読み込み" }).click();
  await expect(page.getByLabel("気温の代表地点", { exact: true })).toHaveValue(
    "44133",
  );
});
test("pending save blocks navigation and Escape until server acknowledgement", async ({
  page,
}) => {
  await setup(page);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/v1/weather-settings", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
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
  await open(page);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "戻る", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "キャンセル" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "天気の地域設定" }),
  ).toBeVisible();
  finish();
  await expect(
    page.getByRole("heading", { name: "天気の地域設定" }),
  ).toHaveCount(0);
});
test("lost save response explains possible persistence and blocks blind retry", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/v1/weather-settings", (route) =>
    route.request().method() === "PUT"
      ? route.abort("failed")
      : route.fallback(),
  );
  await open(page);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("保存された可能性");
  await expect(
    page.getByRole("button", { name: "保存", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "現在の設定を再読み込み" }),
  ).toBeVisible();
});
