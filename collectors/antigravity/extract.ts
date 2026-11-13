import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Usage,
} from "../../packages/usage-contracts/src/index";
import { record } from "../claude/extract";
import { isoInstant } from "../shared/input";

// Exact IDs verified against agy 1.5.1 /usage. Arbitrary model/account names
// must never become public labels.
const groups = [
  {
    id: "gemini-models",
    label: "Gemini Models",
    weekly: "gemini-weekly",
    five: "gemini-5h",
  },
  {
    id: "claude-gpt-models",
    label: "Claude and GPT Models",
    weekly: "3p-weekly",
    five: "3p-5h",
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    weekly: "gemini-argon-wtu-weekly",
  },
] as const;

function quotaEntries(raw: unknown): [string, unknown][] {
  const input = record(raw);
  if (input.quota !== undefined) return Object.entries(record(input.quota));
  const source = record(record(input.command).data).groups;
  if (!Array.isArray(source)) return [];
  return source.slice(0, 32).flatMap((group) => {
    const buckets = record(group).buckets;
    if (!Array.isArray(buckets)) return [];
    return buckets.slice(0, 32).flatMap((value): [string, unknown][] => {
      const bucket = record(value);
      return typeof bucket.id === "string" ? [[bucket.id, bucket]] : [];
    });
  });
}

function quotaWindow(
  id: string,
  label: string,
  value: unknown,
  minutes: number | null,
) {
  const bucket = record(value);
  const fraction = bucket.remaining_fraction;
  const disabled = bucket.disabled === true;
  const usedPercent =
    !disabled &&
    typeof fraction === "number" &&
    Number.isFinite(fraction) &&
    fraction >= 0 &&
    fraction <= 1
      ? Math.round((1 - fraction) * 100 * 1e8) / 1e8
      : null;
  return {
    id,
    label: disabled ? `${label}（無効）` : label,
    usedPercent,
    windowMinutes: minutes,
    // Relative reset seconds have no verified observation instant.
    resetsAt: disabled ? null : isoInstant(bucket.reset_time),
  };
}

/** Reads statusline quota or read-only /usage JSON; never starts the CLI. */
export function extractAntigravity(raw: unknown, capturedAt: string): Usage {
  const entries = quotaEntries(raw)
    .filter(
      ([, value]) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    )
    .slice(0, 32);
  const known = new Set<string>();
  const buckets: Usage["buckets"] = [];
  for (const group of groups) {
    const weekly = entries.find(([id]) => id === group.weekly);
    const fiveId = "five" in group ? group.five : undefined;
    const five = fiveId ? entries.find(([id]) => id === fiveId) : undefined;
    if (!weekly && !five) continue;
    known.add(group.weekly);
    if (fiveId) known.add(fiveId);
    const windows = [];
    if (weekly) windows.push(quotaWindow("weekly", "週間枠", weekly[1], 10080));
    if (five) {
      const window = quotaWindow("five-hour", "5時間枠", five[1], 300);
      if (
        record(five[1]).disabled === true &&
        record(weekly?.[1]).remaining_fraction === 0
      )
        window.label = "5時間枠（週間上限到達で無効）";
      windows.push(window);
    }
    buckets.push({ id: group.id, label: group.label, windows });
  }
  entries.forEach(([id, value], index) => {
    if (known.has(id)) return;
    buckets.push({
      id: `quota-${index + 1}`,
      label: `利用枠 ${index + 1}`,
      windows: [quotaWindow("quota", "利用枠", value, null)],
    });
  });
  return usageSchema.parse({
    ...emptyUsage("antigravity"),
    ...emptyCommon(buckets.length ? "ok" : "missing"),
    capturedAt,
    sourceObservedAt: null,
    buckets,
  });
}
