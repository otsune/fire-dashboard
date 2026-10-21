import { z } from "zod";
import {
  usageDeliveryMetadataSchema,
  type UsageDeliveryMetadata,
} from "./index";
export type { UsageDeliveryMetadata } from "./index";
export { usageDeliveryMetadataSchema } from "./index";
export { usageDeliverySchema } from "./index";
export type { UsageDelivery } from "./index";

const revision = z.string().regex(/^(?:0|[1-9][0-9]{0,38})$/);
const streamId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.string().datetime({ offset: true });

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

export function isUsageDeliveryMetadata(value: unknown): value is UsageDeliveryMetadata {
  return usageDeliveryMetadataSchema.safeParse(value).success;
}
