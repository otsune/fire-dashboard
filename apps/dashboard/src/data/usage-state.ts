import {
  compareUsageRevision,
  parseDashboard,
  usageDeliverySchema,
  type Dashboard,
  type Usage,
  type UsageDelivery,
} from "../../../../packages/contracts/src/index";
import type { UsageHeartbeat } from "../../../../packages/contracts/src/usage-delivery";

export type UsageApplySource = "http" | "mqtt";
export type UsageApplyResult =
  | { accepted: true; dashboard: Dashboard; reason: "initial" | "newer" | "http_authoritative" }
  | { accepted: false; dashboard: Dashboard; reason: "stale" | "duplicate" | "conflict" | "stream" | "invalid" };

function samePayload(left: Usage[], right: Usage[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function usageDeliveryFromDashboard(value: Dashboard): UsageDelivery | null {
  if (!value.usageDelivery) return null;
  const parsed = usageDeliverySchema.safeParse({
    ...value.usageDelivery,
    usage: value.usage,
  });
  return parsed.success ? parsed.data : null;
}

/** Returns whether a heartbeat proves that HTTP should reconcile the state. */
export function shouldRefreshUsageForHeartbeat(
  previous: Dashboard,
  heartbeat: Pick<UsageHeartbeat, "streamId" | "revision" | "deliveryStatus">,
): boolean {
  if (heartbeat.deliveryStatus === "too_large") return true;
  const current = usageDeliveryFromDashboard(previous);
  if (!current) return true;
  const ordering = compareUsageRevision(current, heartbeat);
  return ordering === null || ordering < 0;
}

/** Applies HTTP and MQTT values using one stream/revision ordering rule. */
export function applyUsageDelivery(
  previous: Dashboard,
  incoming: UsageDelivery,
  source: UsageApplySource,
): UsageApplyResult {
  const current = usageDeliveryFromDashboard(previous);
  if (!current) {
    return {
      accepted: true,
      dashboard: { ...previous, usage: incoming.usage, usageDelivery: {
        schemaVersion: 1,
        streamId: incoming.streamId,
        revision: incoming.revision,
        publishedAt: incoming.publishedAt,
      } },
      reason: "initial",
    };
  }
  const ordering = compareUsageRevision(current, incoming);
  if (ordering === null) {
    // HTTP is the authenticated source of truth and is allowed to rotate a
    // stream after backup restore. MQTT never switches streams by itself.
    if (source !== "http")
      return { accepted: false, dashboard: previous, reason: "stream" };
    return {
      accepted: true,
      dashboard: { ...previous, usage: incoming.usage, usageDelivery: {
        schemaVersion: 1,
        streamId: incoming.streamId,
        revision: incoming.revision,
        publishedAt: incoming.publishedAt,
      } },
      reason: "http_authoritative",
    };
  }
  if (ordering > 0)
    return { accepted: false, dashboard: previous, reason: "stale" };
  if (ordering === 0) {
    return {
      accepted: false,
      dashboard: previous,
      reason: samePayload(current.usage, incoming.usage) ? "duplicate" : "conflict",
    };
  }
  return {
    accepted: true,
    dashboard: { ...previous, usage: incoming.usage, usageDelivery: {
      schemaVersion: 1,
      streamId: incoming.streamId,
      revision: incoming.revision,
      publishedAt: incoming.publishedAt,
    } },
    reason: "newer",
  };
}

/** HTTP response helper: preserve weather/RSS and apply only its usage. */
export function applyHttpDashboard(previous: Dashboard, incoming: Dashboard): Dashboard {
  const delivery = usageDeliveryFromDashboard(incoming);
  if (!delivery) return parseDashboard(incoming);
  return { ...applyUsageDelivery(previous, delivery, "http").dashboard, usageConnection: incoming.usageConnection };
}
