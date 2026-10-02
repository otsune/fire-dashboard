import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Usage,
} from "../../packages/contracts/src/index";
import { record } from "../claude/extract";
import { isoInstant } from "../shared/input";

/** Official statusLine stdin only; never invokes agy or reads its credentials. */
export function extractAntigravity(raw: unknown, capturedAt: string): Usage {
  const quotas = record(record(raw).quota);
  const buckets = Object.entries(quotas)
    .filter(
      ([, value]) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    )
    .slice(0, 32)
    .map(([id, value], index) => {
      const bucket = record(value);
      const fraction = bucket.remaining_fraction;
      const usedPercent =
        typeof fraction === "number" &&
        Number.isFinite(fraction) &&
        fraction >= 0 &&
        fraction <= 1
          ? Math.round((1 - fraction) * 100 * 1e8) / 1e8
          : null;
      return {
        // Only the exact documented bucket gets a source-derived identity.
        // Unknown keys may contain account data; retain their quota anonymously.
        id: id === "gemini-weekly" ? "gemini-weekly" : `quota-${index + 1}`,
        label: id === "gemini-weekly" ? "Gemini 週間枠" : `利用枠 ${index + 1}`,
        windows: [
          {
            id: "quota",
            label: "利用枠",
            usedPercent,
            windowMinutes: null,
            // Relative reset_in_seconds has no verified observation instant.
            // Anchoring it to capture time would make replayed input look new.
            resetsAt: isoInstant(bucket.reset_time),
          },
        ],
      };
    });
  return usageSchema.parse({
    ...emptyUsage("antigravity"),
    ...emptyCommon(buckets.length ? "ok" : "missing"),
    capturedAt,
    sourceObservedAt: null,
    buckets,
  });
}
