import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Usage,
} from "../../packages/contracts/src/index";
import { finitePercent, record } from "../claude/extract";
import { isoInstant } from "../shared/input";

/** The official usage.bars serializer sends USD display strings, not raw credits. */
function dollars(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !/^\$(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)\.\d{2}$/.test(value)
  )
    return null;
  const amount = Number(value.slice(1).replaceAll(",", ""));
  return Number.isFinite(amount) &&
    amount >= 0 &&
    Number.isSafeInteger(Math.round(amount * 100))
    ? amount
    : null;
}

/** Consume the sanitized result of the read-only Hermes TUI usage.bars RPC. */
export function extractHermesNous(raw: unknown, capturedAt: string): Usage {
  const envelope = record(raw);
  const root = envelope.jsonrpc === "2.0" ? record(envelope.result) : envelope;
  const base = {
    ...emptyUsage("hermes_nous"),
    ...emptyCommon("missing"),
    capturedAt,
    sourceObservedAt: null,
  };
  if (root.ok === false || (envelope.jsonrpc === "2.0" && envelope.error))
    return usageSchema.parse({
      ...base,
      status: "error",
      errorCode: "invalid_data",
    });
  if (root.ok !== true || root.available !== true)
    return usageSchema.parse(base);
  const plan = record(root.plan_bar);
  const subscriptionRemaining = dollars(root.subscription_remaining_display);
  const purchasedRemaining = dollars(root.topup_remaining_display);
  const totalRemaining = dollars(root.total_spendable_display);
  const monthlyAllowance =
    plan.kind === "plan" ? dollars(plan.total_display) : null;
  const planRemaining = dollars(plan.remaining_display);
  const renewsAt = isoInstant(root.renews_at);
  const pct = finitePercent(plan.pct_used);
  // Display strings round to cents and the official percent rounds to an integer.
  // An over-cap balance, inconsistent plan bar, or unknown denominator is balances-only.
  const validQuota =
    monthlyAllowance !== null &&
    monthlyAllowance > 0 &&
    subscriptionRemaining !== null &&
    subscriptionRemaining <= monthlyAllowance &&
    planRemaining !== null &&
    Math.abs(planRemaining - subscriptionRemaining) < 0.011 &&
    pct !== null &&
    Math.abs(pct - (1 - subscriptionRemaining / monthlyAllowance) * 100) <= 1;
  const hasBalance = [
    subscriptionRemaining,
    purchasedRemaining,
    totalRemaining,
    monthlyAllowance,
  ].some((v) => v !== null);
  return usageSchema.parse({
    ...base,
    status: hasBalance ? "ok" : "missing",
    ...(hasBalance
      ? {
          balance: {
            currency: "USD",
            subscriptionRemaining,
            purchasedRemaining,
            totalRemaining,
            monthlyAllowance,
            renewsAt,
          },
        }
      : {}),
    buckets: validQuota
      ? [
          {
            id: "subscription",
            label: "サブスクリプション",
            windows: [
              {
                id: "monthly",
                label: "月間枠",
                usedPercent: pct,
                windowMinutes: null,
                resetsAt: renewsAt,
              },
            ],
          },
        ]
      : [],
  });
}
