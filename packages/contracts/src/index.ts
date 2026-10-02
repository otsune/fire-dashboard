import { z } from "zod";
const text = z.string().max(2048);
export const instant = z.string().datetime({ offset: false }).nullable();
const pct = z.number().finite().min(0).max(100).nullable();
export const commonSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum([
    "ok",
    "stale",
    "missing",
    "error",
    "unsupported",
    "unconfigured",
  ]),
  sourceObservedAt: instant,
  capturedAt: instant,
  receivedAt: instant,
  freshness: z.enum(["known", "unknown"]),
  lastSuccessAt: instant,
  errorCode: z
    .enum([
      "invalid_data",
      "clock_skew",
      "network",
      "timeout",
      "auth",
      "unsupported",
      "missing",
      "storage",
      "unconfigured",
      "too_large",
      "blocked",
      "rate_limited",
    ])
    .nullable(),
});
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
export const windowSchema = z.object({
  id: text,
  label: text,
  usedPercent: pct,
  windowMinutes: z.number().int().positive().max(5256000).nullable(),
  resetsAt: instant,
});
export const usageSchema = commonSchema.extend({
  provider: z.enum(["claude", "codex"]),
  sourceAlias: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9_-]*$/),
  buckets: z
    .array(
      z.object({
        id: text,
        label: text,
        windows: z.array(windowSchema).max(16),
      }),
    )
    .max(32),
});
export const envelopeSchema = z
  .object({
    snapshotId: z.string().min(1).max(128),
    sourceAlias: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    payload: usageSchema,
  })
  .refine((e) => e.sourceAlias === e.payload.sourceAlias);
export type Weather = z.infer<typeof weatherSchema>;
export type Feed = z.infer<typeof feedSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type UsageEnvelope = z.infer<typeof envelopeSchema>;
export type Common = z.infer<typeof commonSchema>;
export type Dashboard = {
  schemaVersion: 1;
  weather: Weather;
  rss: Feed[];
  usage: Usage[];
};
export function emptyCommon(status: Common["status"] = "unconfigured"): Common {
  return {
    schemaVersion: 1,
    status,
    sourceObservedAt: null,
    capturedAt: null,
    receivedAt: null,
    freshness: "unknown",
    lastSuccessAt: null,
    errorCode: null,
  };
}
export function emptyWeather(): Weather {
  return {
    ...emptyCommon(),
    provider: "jma",
    regionId: null,
    regionLabel: null,
    temperatureStationLabel: null,
    issuedAt: null,
    periods: [],
  };
}
export function emptyUsage(provider: Usage["provider"]): Usage {
  return { ...emptyCommon(), provider, sourceAlias: "", buckets: [] };
}
export function emptyDashboard(): Dashboard {
  return {
    schemaVersion: 1,
    weather: emptyWeather(),
    rss: [],
    usage: [emptyUsage("claude"), emptyUsage("codex")],
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
    })
    .parse(input);
  const w = weatherSchema.safeParse(root.weather);
  return {
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
    usage: root.usage.map((v, i) => {
      const u = usageSchema.safeParse(v);
      return u.success
        ? skew(u.data)
        : {
            ...emptyUsage(
              (v as { provider?: string })?.provider === "codex"
                ? "codex"
                : "claude",
            ),
            status: "error",
            errorCode: "invalid_data",
            sourceAlias: `invalid-${i}`,
          };
    }),
  };
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
export type AppSettings = z.infer<typeof settingsSchema>;
export const defaultSettings: AppSettings = {
  timeZone: "Asia/Tokyo",
  hour12: false,
  audioMode: "voice",
  volume: 0.3,
  quiet: { enabled: false, start: "22:00", end: "07:00" },
  rssAutoRotate: true,
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
  for (const key of Object.keys(fields) as (keyof AppSettings)[]) {
    if (!(key in o)) continue;
    const r = fields[key].safeParse(o[key]);
    if (r.success) Object.assign(value, { [key]: r.data });
    else warnings.push(`設定「${key}」を初期値に戻しました`);
  }
  return { value, warnings };
}
export function parseSettings(input: unknown): AppSettings {
  return readSettings(input).value;
}
