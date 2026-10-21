import { z } from "zod";
import {
  usageDeliveryMetadataSchema,
  type UsageDeliveryMetadata,
} from "./metadata";
export type { UsageDeliveryMetadata } from "./metadata";
export { usageDeliveryMetadataSchema } from "./metadata";

import {
  deliveryRevision as revision,
  deliveryStreamId as streamId,
  deliveryTimestamp as timestamp,
} from "./metadata";

export const usageHeartbeatSchema = z.object({
  schemaVersion: z.literal(1),
  streamId,
  revision,
  instanceId: streamId,
  sentAt: timestamp,
  deliveryStatus: z.enum(["ok", "too_large"]),
});
export type UsageHeartbeat = z.infer<typeof usageHeartbeatSchema>;

export const usageAvailabilitySchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: streamId,
  status: z.enum(["online", "offline"]),
  sentAt: timestamp,
});
export type UsageAvailability = z.infer<typeof usageAvailabilitySchema>;

export function compareUsageRevision(
  left: Pick<UsageDeliveryMetadata, "streamId" | "revision">,
  right: Pick<UsageDeliveryMetadata, "streamId" | "revision">,
): -1 | 0 | 1 | null {
  if (left.streamId !== right.streamId) return null;
  const a = BigInt(left.revision);
  const b = BigInt(right.revision);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isUsageDeliveryMetadata(
  value: unknown,
): value is UsageDeliveryMetadata {
  return usageDeliveryMetadataSchema.safeParse(value).success;
}
