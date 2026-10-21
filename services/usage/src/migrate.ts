import { randomUUID } from "node:crypto";
import { mkdir, link, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { envelopeSchema, usageDeliveryMetadataSchema, usageSchema, type Usage } from "../../../packages/usage-contracts/src/index";
import { emptyUsageState, usageStateSchema, type UsageState } from "./store";

const legacySchema = z.object({
  dashboard: z.object({ schemaVersion: z.literal(1), usage: z.array(usageSchema).max(64), weather: z.unknown(), rss: z.array(z.unknown()).max(32), usageDelivery: usageDeliveryMetadataSchema.optional() }).passthrough(),
  usageSequences: z.record(z.string(), envelopeSchema).default({}),
  usageValues: z.record(z.string(), usageSchema).default({}),
  usageObservedAt: z.record(z.string(), z.string()).default({}),
  streamId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  usageRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,38})$/).optional(),
  usagePublishedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).passthrough();

/** Offline conversion: never reads or writes the live service's store. */
export function extractLegacyUsage(input: unknown): UsageState {
  const old = legacySchema.parse(input);
  const initial = emptyUsageState();
  const metadata = old.dashboard.usageDelivery;
  if (metadata && ((old.streamId && old.streamId !== metadata.streamId) ||
    (old.usageRevision && old.usageRevision !== metadata.revision) ||
    (old.usagePublishedAt && old.usagePublishedAt !== metadata.publishedAt))) throw Error("inconsistent_delivery");
  const usageValues: Record<string, Usage> = { ...old.usageValues };
  for (const value of old.dashboard.usage) if (value.sourceAlias) usageValues[`${value.provider}:${value.sourceAlias}`] ??= value;
  for (const [key, envelope] of Object.entries(old.usageSequences)) {
    if (!usageValues[key] && envelope.payload.status === "ok") usageValues[key] = { ...envelope.payload, receivedAt: null, lastSuccessAt: null };
  }
  const usageObservedAt: Record<string, string> = {};
  for (const [key, value] of Object.entries(old.usageObservedAt))
    if (usageValues[key] && Number.isFinite(Date.parse(value))) usageObservedAt[key] = new Date(value).toISOString();
  return usageStateSchema.parse({
    schemaVersion: 1,
    delivery: { schemaVersion: 1, streamId: old.streamId ?? metadata?.streamId ?? initial.delivery.streamId,
      revision: old.usageRevision ?? metadata?.revision ?? "0", publishedAt: old.usagePublishedAt ?? metadata?.publishedAt ?? initial.delivery.publishedAt,
      usage: old.dashboard.usage },
    usageSequences: old.usageSequences, usageValues, usageObservedAt,
  });
}
export function mergeUsageIntoLegacy(legacy: unknown, usage: UsageState): unknown {
  const old = legacySchema.parse(legacy);
  const state = usageStateSchema.parse(usage);
  const { usage: values, ...metadata } = state.delivery;
  return { ...old, dashboard: { ...old.dashboard, usage: values, usageDelivery: metadata },
    usageSequences: state.usageSequences, usageValues: state.usageValues, usageObservedAt: state.usageObservedAt,
    streamId: metadata.streamId, usageRevision: metadata.revision, usagePublishedAt: metadata.publishedAt };
}
/** link publishes the completed file exclusively: an existing destination is never replaced. */
export async function migrateUsageFile(options: { from: string; to: string; restoreLegacy?: string }) {
  const input: unknown = JSON.parse(await readFile(options.from, "utf8"));
  const value = options.restoreLegacy
    ? mergeUsageIntoLegacy(JSON.parse(await readFile(options.restoreLegacy, "utf8")), usageStateSchema.parse(input))
    : extractLegacyUsage(input);
  await mkdir(dirname(options.to), { recursive: true });
  const temp = `${options.to}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await link(temp, options.to);
  } finally { await unlink(temp).catch(() => {}); }
}
