import {
  emptyUsage,
  emptyCommon,
  usageSchema,
  type Usage,
} from "../../packages/contracts/src/index";
export function finitePercent(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
    ? v
    : null;
}
export function epoch(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 253402300799)
    return null;
  return new Date(v * 1000).toISOString();
}
export function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
export function extractClaude(stdin: unknown, capturedAt: string): Usage {
  const root = record(stdin),
    limits = record(root.rate_limits);
  const windows = [
    ["five_hour", "5時間", 300],
    ["seven_day", "7日間", 10080],
  ] as const;
  const selected = windows
    .filter(([id]) => limits[id] && typeof limits[id] === "object")
    .map(([id, label, windowMinutes]) => {
      const w = record(limits[id]);
      return {
        id,
        label,
        windowMinutes,
        usedPercent: finitePercent(w.used_percentage),
        resetsAt: epoch(w.resets_at),
      };
    });
  return usageSchema.parse({
    ...emptyUsage("claude"),
    ...emptyCommon(selected.length ? "ok" : "missing"),
    capturedAt,
    buckets: selected.length
      ? [{ id: "rate_limits", label: "利用上限", windows: selected }]
      : [],
  });
}
