import { z } from "zod";
import { commonSchema, instant, pct, emptyCommon } from "./common";
export * from "./common";
const text = z.string().max(2048);
const deliveryRevision = z.string().regex(/^(?:0|[1-9][0-9]{0,38})$/);
const deliveryStreamId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const deliveryTimestamp = z.string().datetime({ offset: true });
export const usageDeliveryMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  streamId: deliveryStreamId,
  revision: deliveryRevision,
  publishedAt: deliveryTimestamp,
});
export type UsageDeliveryMetadata = z.infer<typeof usageDeliveryMetadataSchema>;
export const usageProviders = [
  "claude",
  "codex",
  "antigravity",
  "opencode_go",
  "hermes_nous",
  "grok",
] as const;
export const providerSchema = z.enum(usageProviders);
export type UsageProvider = z.infer<typeof providerSchema>;
export const windowSchema = z.object({
  id: text,
  label: text,
  usedPercent: pct,
  windowMinutes: z.number().int().positive().max(5256000).nullable(),
  resetsAt: instant,
});
const amount = z.number().finite().nonnegative().nullable();
export const balanceSchema = z.object({
  currency: z.literal("USD"),
  subscriptionRemaining: amount,
  purchasedRemaining: amount,
  totalRemaining: amount,
  monthlyAllowance: amount,
  renewsAt: instant,
});
export const usageSchema = commonSchema.extend({
  provider: providerSchema,
  balance: balanceSchema.optional(),
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
export type Usage = z.infer<typeof usageSchema>;
export type UsageEnvelope = z.infer<typeof envelopeSchema>;
const uniqueDeliveryUsage = z
  .array(usageSchema)
  .max(usageProviders.length)
  .superRefine((values, ctx) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value.provider))
        ctx.addIssue({
          code: "custom",
          path: [index, "provider"],
          message: "duplicate_provider",
        });
      seen.add(value.provider);
    }
  });
export const usageDeliverySchema = z.object({
  schemaVersion: z.literal(1),
  streamId: deliveryStreamId,
  revision: deliveryRevision,
  publishedAt: deliveryTimestamp,
  usage: uniqueDeliveryUsage,
});
export type UsageDelivery = z.infer<typeof usageDeliverySchema>;
export function emptyUsage(provider: Usage["provider"]): Usage {
  return { ...emptyCommon(), provider, sourceAlias: "", buckets: [] };
}

export * from "./delivery";
