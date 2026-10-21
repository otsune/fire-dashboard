import {
  emptyUsage,
  emptyCommon,
  usageSchema,
  type Usage,
} from "../../packages/usage-contracts/src/index";
import { record, finitePercent, epoch } from "../claude/extract";
export function normalizeCodex(raw: unknown, capturedAt: string): Usage {
  const root = record(raw);
  const multi = record(root.rateLimitsByLimitId);
  const single = record(root.rateLimits);
  const entries: [string, unknown][] = Object.keys(multi).length
    ? Object.entries(multi)
    : Object.keys(single).length
      ? [[String(single.limitId ?? "codex"), single]]
      : [];
  let additional = 0;
  const buckets = entries.slice(0, 32).map(([id, unknown]) => {
    const bucket = record(unknown);
    const known = id === "codex";
    const anonymous = known ? 0 : ++additional;
    return {
      id: known ? "codex" : `additional-${anonymous}`,
      label: known ? "Codex" : `追加利用枠 ${anonymous}`,
      windows: ["primary", "secondary"]
        .filter((key) => bucket[key] && typeof bucket[key] === "object")
        .map((key) => {
          const window = record(bucket[key]);
          const duration = window.windowDurationMins;
          return {
            id: key,
            label: key === "primary" ? "基本枠" : "追加枠",
            usedPercent: finitePercent(window.usedPercent),
            windowMinutes:
              typeof duration === "number" &&
              Number.isInteger(duration) &&
              duration > 0 &&
              duration <= 5256000
                ? duration
                : null,
            resetsAt: epoch(window.resetsAt),
          };
        }),
    };
  });
  return usageSchema.parse({
    ...emptyUsage("codex"),
    ...emptyCommon(buckets.length ? "ok" : "missing"),
    capturedAt,
    sourceObservedAt: null,
    buckets,
  });
}
