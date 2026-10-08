import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { emptyDashboard } from "../../packages/contracts/src/index";
import { normalizeWeather } from "../../services/aggregator/src/weather/jma";

// JMA public response captured 2026-10-09 JST, issued 2026-10-08 17:00 JST.
// https://www.jma.go.jp/bosai/forecast/data/forecast/140000.json
const raw = JSON.parse(
  readFileSync(
    new URL("../fixtures/jma-kanagawa-2026-10-08.json", import.meta.url),
    "utf8",
  ),
);
test.use({ serviceWorkers: "block" });
for (const scenario of ["daily", "weekly", "missing"] as const) {
  test(`JMA ${scenario} temperatures reach the weather card with a prefecture`, async ({
    page,
  }) => {
    const fixture = structuredClone(raw);
    if (scenario === "missing") {
      for (const product of fixture)
        for (const series of product.timeSeries)
          for (const area of series.areas) {
            delete area.temps;
            delete area.tempsMin;
            delete area.tempsMax;
          }
    }
    const time =
      scenario === "weekly"
        ? "2026-10-10T03:00:00+09:00"
        : "2026-10-09T03:00:00+09:00";
    const data = emptyDashboard();
    data.weather = normalizeWeather(
      fixture,
      "140010",
      new Date(time).toISOString(),
      { stationId: "46106" },
    );
    if (scenario === "weekly") {
      // Regenerate with a rain period for the following day, as in a morning issue.
      const rain = fixture[0].timeSeries.find(
        (s: { areas: { pops?: string[] }[] }) => s.areas.some((a) => a.pops),
      );
      rain.timeDefines.push("2026-10-10T00:00:00+09:00");
      for (const area of rain.areas) area.pops.push("10");
      data.weather = normalizeWeather(
        fixture,
        "140010",
        new Date(time).toISOString(),
        { stationId: "46106" },
      );
    }
    await page.clock.install({ time: new Date(time) });
    await page.route("**/api/v1/dashboard", (route) =>
      route.fulfill({ json: data }),
    );
    await page.goto("/");
    const card = page.locator(".weather-card");
    await expect(
      card.getByRole("heading", { name: "神奈川県 東部" }),
    ).toBeVisible();
    await expect(card).toContainText(
      scenario === "missing"
        ? "予報気温 —〜— °C"
        : scenario === "weekly"
          ? "予報気温 17〜25 °C"
          : "予報気温 16〜25 °C",
    );
    if (scenario === "daily") await expect(card).toContainText("晴れ");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
