import { z } from "zod";
export const instant = z.string().datetime({ offset: false }).nullable();
export const pct = z.number().finite().min(0).max(100).nullable();
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

export type Common = z.infer<typeof commonSchema>;
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
