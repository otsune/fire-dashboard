import { z } from "zod";
export const deliveryRevision = z.string().regex(/^(?:0|[1-9][0-9]{0,38})$/);
export const deliveryStreamId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const deliveryTimestamp = z.string().datetime({ offset: true });
export const usageDeliveryMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  streamId: deliveryStreamId,
  revision: deliveryRevision,
  publishedAt: deliveryTimestamp,
});
export type UsageDeliveryMetadata = z.infer<typeof usageDeliveryMetadataSchema>;
