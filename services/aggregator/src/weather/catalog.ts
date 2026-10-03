import { z } from "zod";
import {
  weatherOfficeSchema,
  weatherOfficesSchema,
  weatherSelectionSchema,
  type WeatherOffices,
  type WeatherOffice,
  type WeatherSelection,
} from "../../../../packages/contracts/src/index";
import { safeFetch } from "../fetch/safe-fetch";

export const JMA_AREA_URL =
  "https://www.jma.go.jp/bosai/common/const/area.json";
const officeId = z.string().regex(/^\d{6}$/);
const label = z.string().min(1).max(200);
const areaSchema = z.object({
  offices: z
    .record(officeId, z.object({ name: label }))
    .refine(
      (value) =>
        Object.keys(value).length > 0 && Object.keys(value).length <= 200,
    ),
});
const values = z.array(z.string().max(300)).max(128);
const forecastSchema = z
  .array(
    z.object({
      reportDatetime: z.string().datetime({ offset: true }),
      timeSeries: z
        .array(
          z.object({
            timeDefines: z
              .array(z.string().datetime({ offset: true }))
              .min(1)
              .max(128),
            areas: z
              .array(
                z.object({
                  area: z.object({
                    code: z.string().regex(/^\d{5,7}$/),
                    name: label,
                  }),
                  weathers: values.optional(),
                  tempsMin: values.optional(),
                  tempsMax: values.optional(),
                }),
              )
              .min(1)
              .max(1000),
          }),
        )
        .min(1)
        .max(32),
    }),
  )
  .min(1)
  .max(8);
const cacheMs = 6 * 60 * 60 * 1000;
export function jmaForecastUrl(office: string): string {
  if (!officeId.safeParse(office).success) throw Error("invalid_data");
  return `https://www.jma.go.jp/bosai/forecast/data/forecast/${office}.json`;
}
export type WeatherCatalog = {
  offices(): Promise<WeatherOffices>;
  office(id: string): Promise<WeatherOffice>;
  validate(selection: WeatherSelection): Promise<WeatherOffice>;
};
export function createWeatherCatalog(
  deps: { fetch?: typeof safeFetch; now?: () => number } = {},
): WeatherCatalog {
  const fetch = deps.fetch ?? safeFetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expires: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const previous = cache.get(key);
    if (previous && now() < previous.expires)
      return structuredClone(previous.value) as T;
    let work = pending.get(key) as Promise<T> | undefined;
    if (!work) {
      work = load()
        .then((value) => {
          cache.set(key, { expires: now() + cacheMs, value });
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return structuredClone(await work);
  }
  async function json(url: string): Promise<unknown> {
    try {
      const res = await fetch(new URL(url), {
        allowedHostsPaths: [url],
        timeoutMs: 10000,
        maxBytes: 2 * 1024 * 1024,
      });
      if (res.status !== 200 || res.body.length > 2 * 1024 * 1024)
        throw Error("response");
      return JSON.parse(Buffer.from(res.body).toString("utf8"));
    } catch {
      throw Error("catalog_unavailable");
    }
  }
  const offices = () =>
    cached("offices", async () => {
      try {
        const parsed = areaSchema.parse(await json(JMA_AREA_URL));
        return weatherOfficesSchema.parse({
          offices: Object.entries(parsed.offices).map(([id, value]) => ({
            id,
            label: value.name,
          })),
        });
      } catch {
        throw Error("catalog_unavailable");
      }
    });
  async function office(id: string): Promise<WeatherOffice> {
    const url = jmaForecastUrl(id);
    // Membership is checked before the office-specific URL can be fetched.
    const named = (await offices()).offices.find((value) => value.id === id);
    if (!named) throw Error("invalid_data");
    return cached(`office:${id}`, async () => {
      try {
        const parsed = forecastSchema.parse(await json(url));
        const regions = new Map<string, string>(),
          stations = new Map<string, string>();
        for (const entry of parsed
          .flatMap((value) => value.timeSeries)
          .flatMap((value) => value.areas)) {
          if (entry.weathers && /^\d{6}$/.test(entry.area.code))
            regions.set(entry.area.code, entry.area.name);
          if (entry.tempsMin || entry.tempsMax)
            stations.set(entry.area.code, entry.area.name);
        }
        if (!regions.size) throw Error("forecast");
        return weatherOfficeSchema.parse({
          office: named,
          regions: Array.from(regions, ([id, label]) => ({ id, label })),
          stations: Array.from(stations, ([id, label]) => ({ id, label })),
        });
      } catch {
        throw Error("catalog_unavailable");
      }
    });
  }
  return {
    offices,
    office,
    validate: async (selection) => {
      const valid = weatherSelectionSchema.safeParse(selection);
      if (!valid.success) throw Error("invalid_data");
      const value = await office(valid.data.office);
      if (
        !value.regions.some((region) => region.id === valid.data.region) ||
        !value.stations.some((station) => station.id === valid.data.station)
      )
        throw Error("invalid_data");
      return value;
    },
  };
}
