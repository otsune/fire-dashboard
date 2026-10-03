import { expect, it } from "vitest";
import {
  createWeatherCatalog,
  JMA_AREA_URL,
  jmaForecastUrl,
} from "../../services/aggregator/src/weather/catalog";
import type { safeFetch } from "../../services/aggregator/src/fetch/safe-fetch";
const area = {
  offices: { "130000": { name: "東京都" }, "140000": { name: "神奈川県" } },
};
import { forecast, response } from "../helpers/weather-catalog";
function catalogHarness() {
  const urls: string[] = [];
  let now = 0;
  const fetch: typeof safeFetch = async (url, policy) => {
    urls.push(url.href);
    expect(policy.allowedHostsPaths).toEqual([url.href]);
    return response(url.href === JMA_AREA_URL ? area : forecast);
  };
  return {
    catalog: createWeatherCatalog({ fetch, now: () => now }),
    urls,
    advance: () => {
      now += 6 * 60 * 60 * 1000;
    },
  };
}
it("loads fixed official offices and field-specific forecast districts and stations", async () => {
  const { catalog, urls } = catalogHarness();
  expect(await catalog.offices()).toEqual({
    offices: [
      { id: "130000", label: "東京都" },
      { id: "140000", label: "神奈川県" },
    ],
  });
  expect(await catalog.office("130000")).toEqual({
    office: { id: "130000", label: "東京都" },
    regions: [{ id: "130010", label: "東京地方" }],
    stations: [
      { id: "44132", label: "東京" },
      { id: "44133", label: "別地点" },
    ],
  });
  expect(urls).toEqual([
    "https://www.jma.go.jp/bosai/common/const/area.json",
    "https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json",
  ]);
});
it("caches catalog data for six hours and returns independent values", async () => {
  const { catalog, urls, advance } = catalogHarness();
  const first = await catalog.office("130000");
  first.regions[0].label = "tampered";
  expect((await catalog.office("130000")).regions[0].label).toBe("東京地方");
  expect(urls).toHaveLength(2);
  advance();
  await catalog.office("130000");
  expect(urls).toHaveLength(4);
});
it("rejects invalid office IDs before constructing or fetching any URL", async () => {
  const { catalog, urls } = catalogHarness();
  for (const id of ["../130000", "https://evil", "130000?x", "12345"]) {
    expect(() => jmaForecastUrl(id)).toThrow("invalid_data");
    await expect(catalog.office(id)).rejects.toThrow("invalid_data");
  }
  expect(urls).toEqual([]);
  await expect(catalog.office("999999")).rejects.toThrow("invalid_data");
  expect(urls).toEqual([JMA_AREA_URL]);
});
it.each([
  { office: "130000", region: "130020", station: "44132" },
  { office: "130000", region: "130010", station: "44134" },
  { office: "130000", region: "130010", station: "99999" },
])("rejects unknown or unsupported membership %j", async (selection) => {
  const { catalog } = catalogHarness();
  await expect(catalog.validate(selection)).rejects.toThrow("invalid_data");
});
it("returns server labels only for a valid explicit selection", async () => {
  const { catalog } = catalogHarness();
  const value = await catalog.validate({
    office: "130000",
    region: "130010",
    station: "44132",
  });
  expect(value.regions[0].label).toBe("東京地方");
});
it.each([
  {},
  { offices: { "130000": { name: "x".repeat(201) } } },
  { offices: { "../../": { name: "bad" } } },
])("fails closed on malformed area metadata %j", async (value) => {
  const catalog = createWeatherCatalog({ fetch: async () => response(value) });
  await expect(catalog.offices()).rejects.toThrow("catalog_unavailable");
});
it.each([
  {},
  [{ reportDatetime: "x", timeSeries: [] }],
  [
    {
      reportDatetime: "2026-10-03T05:00:00+09:00",
      timeSeries: [
        {
          timeDefines: [],
          areas: [{ area: { code: "44132", name: "x" }, tempsMax: [3] }],
        },
      ],
    },
  ],
])("fails closed on malformed forecast %j", async (value) => {
  const catalog = createWeatherCatalog({
    fetch: async (url) => response(url.href === JMA_AREA_URL ? area : value),
  });
  await expect(catalog.office("130000")).rejects.toThrow("catalog_unavailable");
});
it("does not cache network failures and can retry", async () => {
  let available = false;
  const catalog = createWeatherCatalog({
    fetch: async () => {
      if (!available) throw Error("secret network detail");
      return response(area);
    },
  });
  await expect(catalog.offices()).rejects.toThrow("catalog_unavailable");
  available = true;
  expect((await catalog.offices()).offices).toHaveLength(2);
});
