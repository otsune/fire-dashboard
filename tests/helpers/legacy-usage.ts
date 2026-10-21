// Adapt pre-split fixtures to the real usage engine; no second ingest implementation.
import type { Store, State } from "../../services/aggregator/src/store";
import type { UsageStore, UsageState } from "../../services/usage/src/store";
import { createUsageIngestorWithRevision as ingest } from "../../services/usage/src/ingest";
import type { Usage } from "../../packages/usage-contracts/src/index";
export { createRateLimiter } from "../../services/usage/src/ingest";

function usageState(state: State): UsageState {
  return {
    schemaVersion: 1,
    delivery: {
      schemaVersion: 1,
      streamId: state.streamId,
      revision: state.usageRevision,
      publishedAt: state.usagePublishedAt ?? new Date().toISOString(),
      ...state.dashboard.usageDelivery,
      usage: state.dashboard.usage,
    },
    usageSequences: state.usageSequences,
    usageValues: state.usageValues,
    usageObservedAt: state.usageObservedAt,
  };
}
export function legacyUsageStore(store: Store): UsageStore {
  const inspect: UsageStore["inspect"] = (fn) =>
    store.inspect((s) => fn(usageState(s)));
  return {
    inspect,
    readState: () => inspect((s) => s),
    readDelivery: () => inspect((s) => s.delivery),
    update: (fn) =>
      store.update((old) => {
        const next = fn(usageState(old));
        const { usage, ...metadata } = next.state.delivery;
        return {
          state: {
            ...old,
            dashboard: { ...old.dashboard, usage, usageDelivery: metadata },
            usageSequences: next.state.usageSequences,
            usageValues: next.state.usageValues,
            usageObservedAt: next.state.usageObservedAt,
            streamId: metadata.streamId,
            usageRevision: metadata.revision,
            usagePublishedAt: metadata.publishedAt,
          },
          result: next.result,
        };
      }),
  };
}
export function createUsageIngestorWithRevision(
  store: Store,
  sources: Partial<Record<Usage["provider"], string | readonly string[]>>,
) {
  return ingest(legacyUsageStore(store), sources);
}
export function createUsageIngestor(
  store: Store,
  sources: Partial<Record<Usage["provider"], string | readonly string[]>>,
) {
  const apply = createUsageIngestorWithRevision(store, sources);
  return async (...args: Parameters<typeof apply>) =>
    (await apply(...args)).status;
}
