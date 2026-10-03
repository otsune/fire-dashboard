import {
  envelopeSchema,
  usageProviders,
  type UsageEnvelope,
  type Usage,
} from "../../../../packages/contracts/src/index";
import type { Store } from "../store";
export function createUsageIngestor(
  store: Store,
  preferredSources: Partial<
    Record<Usage["provider"], string | readonly string[]>
  >,
) {
  // Limits are account-wide, so every listed PC observes the same windows;
  // any of them may report and the freshest observation is displayed.
  const allowed = (provider: Usage["provider"], alias: string) => {
    const listed = preferredSources[provider];
    return typeof listed === "string"
      ? listed === alias
      : !!listed?.includes(alias);
  };
  return async function ingestUsage(
    input: UsageEnvelope,
    receivedAt: string,
    authorizedAlias: string,
  ): Promise<"accepted" | "duplicate" | "older"> {
    const envelope = envelopeSchema.parse(input);
    if (
      envelope.sourceAlias !== authorizedAlias ||
      !allowed(envelope.payload.provider, authorizedAlias)
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
      }
      const payload = envelope.payload;
      const duplicate = previous?.sequence === envelope.sequence;
      const existing = state.usageValues[key];
      // Keep the raw envelope unchanged for sequence/conflict checks. The
      // effective value also holds data inherited from this source's success.
      // Legacy successful values may have no known receipt/success time.
      // Retain their available data through subsequent errors as well.
      const hasRetainedData =
        existing &&
        (existing.lastSuccessAt ||
          existing.status === "ok" ||
          existing.buckets.length > 0 ||
          existing.balance);
      const value: Usage =
        duplicate && existing
          ? { ...existing, receivedAt }
          : hasRetainedData && payload.status === "error"
            ? {
                ...existing,
                status: payload.status,
                errorCode: payload.errorCode,
                receivedAt,
              }
            : {
                ...payload,
                receivedAt,
                // Legacy off-screen envelopes have no trustworthy receipt time.
                lastSuccessAt:
                  !duplicate && payload.status === "ok" ? receivedAt : null,
              };
      // Save every source's effective value before choosing what to display,
      // so a source that is not on screen keeps its own last good data.
      // The comparison time is fixed when a snapshot is first received; a
      // heartbeat only updates receivedAt and must not make old data "newer".
      // Legacy state without it falls back to this source's previous receipt.
      const observed =
        (duplicate && state.usageObservedAt[key]) ||
        new Date(
          observedAt(duplicate && existing ? existing : payload, receivedAt),
        ).toISOString();
      state.usageSequences[key] = envelope;
      state.usageValues[key] = value;
      state.usageObservedAt[key] = observed;
      const result = duplicate ? ("duplicate" as const) : ("accepted" as const);
      // One entry per provider is displayed, from whichever PC reported it.
      const shown = state.dashboard.usage.find(
        (u) => u.provider === payload.provider,
      );
      // Another PC's failure must not hide a working PC's numbers, and an
      // older capture (e.g. a PC waking from sleep) must not replace a newer
      // one. A working PC's numbers do replace another PC's failure.
      // A PC removed from the configuration no longer holds the display.
      if (
        shown &&
        (shown.lastSuccessAt || shown.status === "ok") &&
        shown.sourceAlias !== authorizedAlias &&
        allowed(payload.provider, shown.sourceAlias) &&
        (value.status !== "ok" ||
          (shown.status === "ok" &&
            Date.parse(observed) <
              (Date.parse(
                state.usageObservedAt[`${shown.provider}:${shown.sourceAlias}`],
              ) || observedAt(shown, receivedAt))))
      )
        return { state, result };
      state.dashboard.usage = state.dashboard.usage.filter(
        (u) => u.provider !== payload.provider,
      );
      state.dashboard.usage.push(value);
      state.dashboard.usage.sort(
        (a, b) =>
          usageProviders.indexOf(a.provider) -
          usageProviders.indexOf(b.provider),
      );
      return { state, result };
    });
  };
}
/** Collector clocks may run ahead; a capture never counts as newer than its receipt. */
function observedAt(
  u: Pick<Usage, "capturedAt" | "receivedAt">,
  fallback: string,
): number {
  const received = Date.parse(u.receivedAt ?? fallback);
  const captured = u.capturedAt ? Date.parse(u.capturedAt) : NaN;
  return Number.isFinite(captured) ? Math.min(captured, received) : received;
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
