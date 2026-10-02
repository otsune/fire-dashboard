import {
  envelopeSchema,
  usageProviders,
  type UsageEnvelope,
  type Usage,
} from "../../../../packages/contracts/src/index";
import type { Store } from "../store";
export function createUsageIngestor(
  store: Store,
  preferredSources: Partial<Record<Usage["provider"], string>>,
) {
  return async function ingestUsage(
    input: UsageEnvelope,
    receivedAt: string,
    authorizedAlias: string,
  ): Promise<"accepted" | "duplicate" | "older"> {
    const envelope = envelopeSchema.parse(input);
    if (
      envelope.sourceAlias !== authorizedAlias ||
      preferredSources[envelope.payload.provider] !== authorizedAlias
    )
      throw Error("source_denied");
    return store.update((state) => {
      const key = `${envelope.payload.provider}:${authorizedAlias}`;
      const previous = state.usageSequences[key];
      if (previous && envelope.sequence < previous.sequence)
        return { state, result: "older" as const };
      if (previous && envelope.sequence === previous.sequence) {
        if (
          envelope.snapshotId !== previous.snapshotId ||
          JSON.stringify(envelope.payload) !== JSON.stringify(previous.payload)
        )
          throw Error("snapshot_conflict");
        const existing = state.dashboard.usage.find(
          (u) =>
            u.provider === envelope.payload.provider &&
            u.sourceAlias === authorizedAlias,
        );
        if (existing) {
          existing.receivedAt = receivedAt;
          existing.lastSuccessAt = receivedAt;
          return { state, result: "duplicate" as const };
        }
        // A previously accepted source can become preferred again. Restore its
        // unchanged snapshot rather than keeping another source on screen.
      }
      state.usageSequences[key] = envelope;
      const existing = state.dashboard.usage.find(
        (u) =>
          u.provider === envelope.payload.provider &&
          u.sourceAlias === authorizedAlias,
      );
      const payload = envelope.payload;
      const value =
        existing?.lastSuccessAt && payload.status === "error"
          ? {
              ...existing,
              status: payload.status,
              errorCode: payload.errorCode,
              receivedAt,
            }
          : { ...payload, receivedAt, lastSuccessAt: receivedAt };
      state.dashboard.usage = state.dashboard.usage.filter(
        (u) => u.provider !== payload.provider,
      );
      state.dashboard.usage.push(value);
      state.dashboard.usage.sort(
        (a, b) =>
          usageProviders.indexOf(a.provider) -
          usageProviders.indexOf(b.provider),
      );
      return {
        state,
        result:
          previous?.sequence === envelope.sequence
            ? ("duplicate" as const)
            : ("accepted" as const),
      };
    });
  };
}
export function createRateLimiter() {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (alias: string, now = Date.now()) => {
    let bucket = buckets.get(alias);
    if (!bucket) {
      if (buckets.size >= 128) return false;
      bucket = { tokens: 5, at: now };
    }
    bucket.tokens = Math.min(
      5,
      bucket.tokens + Math.max(0, now - bucket.at) / 1000,
    );
    bucket.at = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens--;
    buckets.set(alias, bucket);
    return allowed;
  };
}
