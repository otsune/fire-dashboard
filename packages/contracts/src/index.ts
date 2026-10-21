import { commonSchema, instant, pct, emptyCommon, emptyUsage, usageProviders, usageSchema, providerSchema, usageDeliveryMetadataSchema, type Usage, type Common } from "../../usage-contracts/src/index";
export * from "../../usage-contracts/src/index";
import { z } from "zod";
import {
  defaultUsageVisibility,
  readUsageVisibility,
  type UsageVisibility,
} from "./display-settings";
const text = z.string().max(2048);
const periodSchema = z
  .object({
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    summary: text.nullable(),
    weatherCode: text.nullable(),
    temperatureMinC: z.number().min(-100).max(100).nullable(),
    temperatureMaxC: z.number().min(-100).max(100).nullable(),
    precipitationProbabilityPct: pct,
  })
  .refine((p) => Date.parse(p.endsAt) > Date.parse(p.startsAt));
export const weatherSchema = commonSchema.extend({
  configurationRevision: z.string().min(1).max(128).nullable().default(null),
  provider: text,
  regionId: text.nullable(),
  regionLabel: text.nullable(),
  temperatureStationLabel: text.nullable(),
  issuedAt: instant,
  periods: z.array(periodSchema).max(64),
});
export const safeLink = z
  .string()
  .max(2048)
  .url()
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  });
export const feedSchema = commonSchema.extend({
  id: text,
  label: text,
  items: z
    .array(
      z.object({
        id: text,
        title: z.string().max(300),
        url: safeLink.nullable(),
        publishedAt: instant,
        sourceLabel: text,
      }),
    )
    .max(20),
});
export type Weather = z.infer<typeof weatherSchema>;
export type Feed = z.infer<typeof feedSchema>;
export type Dashboard = {
  schemaVersion: 1;
  weather: Weather;
  rss: Feed[];
  usage: Usage[];
  usageDelivery?: import("./usage-delivery").UsageDeliveryMetadata;
};
export function emptyWeather(): Weather {
  return {
    ...emptyCommon(),
    provider: "jma",
    configurationRevision: null,
    regionId: null,
    regionLabel: null,
    temperatureStationLabel: null,
    issuedAt: null,
    periods: [],
  };
}
export function emptyDashboard(): Dashboard {
  return {
    schemaVersion: 1,
    weather: emptyWeather(),
    rss: [],
    usage: usageProviders.map(emptyUsage),
  };
}
function skew<T extends Common>(v: T): T {
  const future = Date.now() + 120000;
  return [v.receivedAt, v.capturedAt, v.sourceObservedAt, v.lastSuccessAt].some(
    (t) => t && Date.parse(t) > future,
  )
    ? { ...v, errorCode: "clock_skew" }
    : v;
}
export function parseDashboard(input: unknown): Dashboard {
  const root = z
    .object({
      schemaVersion: z.literal(1),
      weather: z.unknown(),
      rss: z.array(z.unknown()).max(32),
      usage: z.array(z.unknown()).max(64),
      usageDelivery: z.unknown().optional(),
    })
    .parse(input);
  const w = weatherSchema.safeParse(root.weather);
  const delivery = root.usageDelivery
    ? usageDeliveryMetadataSchema.safeParse(root.usageDelivery)
    : undefined;
  const dashboard: Dashboard = {
    schemaVersion: 1,
    weather: w.success
      ? skew(w.data)
      : { ...emptyWeather(), status: "error", errorCode: "invalid_data" },
    rss: root.rss.map((v, i) => {
      const f = feedSchema.safeParse(v);
      return f.success
        ? skew(f.data)
        : {
            ...emptyCommon("error"),
            id: `invalid-${i}`,
            label: "RSS",
            items: [],
            errorCode: "invalid_data",
          };
    }),
    usage: root.usage.flatMap((v, i): Usage[] => {
      const u = usageSchema.safeParse(v);
      if (u.success) return [skew(u.data)];
      const provider = providerSchema.safeParse(
        typeof v === "object" && v !== null
          ? (v as { provider?: unknown }).provider
          : undefined,
      );
      // Unknown data cannot be attributed to one of the known accounts.
      if (!provider.success) return [];
      return [
        {
          ...emptyUsage(provider.data),
          status: "error",
          errorCode: "invalid_data",
          sourceAlias: `invalid-${i}`,
        },
      ];
    }),
  };
  if (delivery?.success) dashboard.usageDelivery = delivery.data;
  return dashboard;
}
const zone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("ja-JP", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  });
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const fields = {
  timeZone: zone,
  hour12: z.boolean(),
  audioMode: z.enum(["voice", "chime", "both", "off"]),
  volume: z.number().min(0).max(1),
  quiet: z
    .object({ enabled: z.boolean(), start: hm, end: hm })
    .refine((v) => v.start !== v.end),
  rssAutoRotate: z.boolean(),
};
const settingsSchema = z.object(fields);
export type AppSettings = z.infer<typeof settingsSchema> & {
  // Downgrading preserves stored JSON; saving in the old version drops this field.
  usageVisibility: UsageVisibility;
};
export const defaultSettings: AppSettings = {
  timeZone: "Asia/Tokyo",
  hour12: false,
  audioMode: "voice",
  volume: 0.3,
  quiet: { enabled: false, start: "22:00", end: "07:00" },
  rssAutoRotate: true,
  usageVisibility: defaultUsageVisibility,
};
export function readSettings(input: unknown): {
  value: AppSettings;
  warnings: string[];
} {
  const value = structuredClone(defaultSettings);
  const warnings: string[] = [];
  const o =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (!(key in o)) continue;
    const r = fields[key].safeParse(o[key]);
    if (r.success) Object.assign(value, { [key]: r.data });
    else warnings.push(`設定「${key}」を初期値に戻しました`);
  }
  const visibility = readUsageVisibility(o.usageVisibility);
  value.usageVisibility = visibility.value;
  warnings.push(...visibility.warnings);
  return { value, warnings };
}
export function parseSettings(input: unknown): AppSettings {
  return readSettings(input).value;
}
export * from "./weather-settings";
export * from "./display-settings";
