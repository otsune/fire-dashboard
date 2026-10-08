import { z } from "zod";
import {
  emptyWeather,
  emptyCommon,
  weatherSchema,
  type Weather,
} from "../../../../packages/contracts/src/index";
const area = z.object({
  area: z.object({ code: z.string(), name: z.string() }),
  weathers: z.array(z.string()).optional(),
  weatherCodes: z.array(z.string()).optional(),
  pops: z.array(z.string()).optional(),
  temps: z.array(z.string()).optional(),
  tempsMin: z.array(z.string()).optional(),
  tempsMax: z.array(z.string()).optional(),
});
const source = z
  .array(
    z.object({
      reportDatetime: z.string(),
      timeSeries: z.array(
        z.object({ timeDefines: z.array(z.string()), areas: z.array(area) }),
      ),
    }),
  )
  .min(1);
const numeric = (v: string | undefined, min: number, max: number) => {
  if (!v?.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const utc = (s: string) => new Date(s).toISOString();
const day = (s: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(s));
export function normalizeWeather(
  raw: unknown,
  regionId: string,
  capturedAt: string,
  options: { stationId?: string } = {},
): Weather {
  if (!regionId) return emptyWeather();
  try {
    const parsed = source.parse(raw);
    const series = parsed.flatMap((p) => p.timeSeries);
    const weather = series.find((s) =>
      s.areas.some((a) => a.area.code === regionId && a.weathers),
    );
    const region = weather?.areas.find((a) => a.area.code === regionId);
    if (!weather || !region) throw Error("region");
    const rain = series.find((s) =>
      s.areas.some((a) => a.area.code === regionId && a.pops),
    );
    const rainArea = rain?.areas.find((a) => a.area.code === regionId);
    const temperature = series.filter((s) =>
      s.areas.some((a) => a.area.code === options.stationId),
    );
    const station = temperature
      .flatMap((s) => s.areas)
      .find((a) => a.area.code === options.stationId);
    const defines = rain?.timeDefines ?? weather.timeDefines;
    const periods = defines.map((start, index) => {
      const startsAt = utc(start),
        endsAt = defines[index + 1]
          ? utc(defines[index + 1])
          : new Date(
              Date.parse(start) + (rain ? 6 : 24) * 3600000,
            ).toISOString();
      const weatherIndex = weather.timeDefines.findIndex(
        (v, i) =>
          Date.parse(v) <= Date.parse(start) &&
          (!weather.timeDefines[i + 1] ||
            Date.parse(weather.timeDefines[i + 1]) > Date.parse(start)),
      );
      let temperatureMinC: number | null = null,
        temperatureMaxC: number | null = null;
      for (const s of temperature) {
        const i = s.timeDefines.findIndex((v) => day(v) === day(start));
        const a = s.areas.find((a) => a.area.code === options.stationId);
        if (i >= 0 && a) {
          // Daily forecasts encode lows at 00:00 and highs at 09:00/18:00 JST.
          // Weekly arrays often leave today's entry blank: do not erase daily values.
          s.timeDefines.forEach((time, index) => {
            if (day(time) !== day(start)) return;
            const hour = new Intl.DateTimeFormat("en", {
              timeZone: "Asia/Tokyo",
              hour: "2-digit",
              hourCycle: "h23",
            }).format(new Date(time));
            const value = numeric(a.temps?.[index], -100, 100);
            if (hour === "00") temperatureMinC = value ?? temperatureMinC;
            if (hour === "09" || hour === "18")
              temperatureMaxC = value ?? temperatureMaxC;
          });
          temperatureMinC =
            numeric(a.tempsMin?.[i], -100, 100) ?? temperatureMinC;
          temperatureMaxC =
            numeric(a.tempsMax?.[i], -100, 100) ?? temperatureMaxC;
        }
      }
      return {
        startsAt,
        endsAt,
        summary: region.weathers?.[weatherIndex]?.replace(/\s+/g, " ") ?? null,
        weatherCode: region.weatherCodes?.[weatherIndex] ?? null,
        temperatureMinC,
        temperatureMaxC,
        precipitationProbabilityPct: numeric(rainArea?.pops?.[index], 0, 100),
      };
    });
    const issuedAt = utc(parsed[0].reportDatetime);
    return weatherSchema.parse({
      ...emptyCommon("ok"),
      provider: "jma",
      regionId,
      regionLabel: region.area.name,
      temperatureStationLabel: station?.area.name ?? null,
      issuedAt,
      periods,
      sourceObservedAt: issuedAt,
      capturedAt,
      receivedAt: capturedAt,
      lastSuccessAt: capturedAt,
      freshness: "known",
    });
  } catch {
    return {
      ...emptyWeather(),
      regionId,
      status: "error",
      errorCode: "invalid_data",
      capturedAt,
      receivedAt: capturedAt,
    };
  }
}
