import { emptyCommon, emptyUsage, type UsageEnvelope } from "../../packages/usage-contracts/src/index";
export const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 0, minute)).toISOString();
export function usageEnvelope(sequence: number, alias = "desk", percent: number | null = 30, minute = sequence): UsageEnvelope {
  return { snapshotId: `${alias}-${sequence}`, sourceAlias: alias, sequence, payload: {
    ...emptyUsage("claude"), ...emptyCommon("ok"), sourceAlias: alias, capturedAt: at(minute),
    buckets: [{ id: "rate", label: "使用率", windows: [{ id: "five", label: "5時間", usedPercent: percent, windowMinutes: 300, resetsAt: null }] }],
  } };
}
