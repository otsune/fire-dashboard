import { it, expect } from "vitest";
import { createUsageIngestor } from "../../services/aggregator/src/usage/ingest";
import { createMemoryStore } from "../../services/aggregator/src/store";
import {
  emptyUsage,
  emptyCommon,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
import { createSender } from "../../collectors/shared/sender";
const at = "2026-10-02T00:00:00.000Z";
function envelope(sequence: number, percent = 80): UsageEnvelope {
  return {
    snapshotId: `s${sequence}`,
    sequence,
    sourceAlias: "pc",
    payload: {
      ...emptyUsage("claude"),
      ...emptyCommon("ok"),
      sourceAlias: "pc",
      capturedAt: at,
      buckets: [
        {
          id: "rate",
          label: "rate",
          windows: [
            {
              id: "five",
              label: "5時間",
              usedPercent: percent,
              windowMinutes: 300,
              resetsAt: null,
            },
          ],
        },
      ],
    },
  };
}
it("uses sequence ordering and accepts rate drops after resets", async () => {
  const store = createMemoryStore();
  const ingest = createUsageIngestor(store, { claude: "pc" });
  expect(await ingest(envelope(2), at, "pc")).toBe("accepted");
  expect(await ingest(envelope(1), at, "pc")).toBe("older");
  expect(await ingest(envelope(3, 5), at, "pc")).toBe("accepted");
  expect(
    (await store.readSnapshot()).usage[0].buckets[0].windows[0].usedPercent,
  ).toBe(5);
});
it("heartbeats update receipt but never rewrite observation or capture", async () => {
  const store = createMemoryStore();
  const ingest = createUsageIngestor(store, { claude: "pc" });
  await ingest(envelope(1), at, "pc");
  const later = "2026-10-02T00:01:00.000Z";
  expect(await ingest(envelope(1), later, "pc")).toBe("duplicate");
  const u = (await store.readSnapshot()).usage[0];
  expect(u.capturedAt).toBe(at);
  expect(u.sourceObservedAt).toBeNull();
  expect(u.receivedAt).toBe(later);
});
it("rejects forged aliases and nonpreferred sources", async () => {
  const ingest = createUsageIngestor(createMemoryStore(), { claude: "pc" });
  await expect(ingest(envelope(1), at, "other")).rejects.toThrow(
    "source_denied",
  );
  const other = envelope(1);
  other.sourceAlias = other.payload.sourceAlias = "other";
  await expect(ingest(other, at, "other")).rejects.toThrow("source_denied");
});
it("rejects altered duplicate payload rather than laundering timestamps", async () => {
  const ingest = createUsageIngestor(createMemoryStore(), { claude: "pc" });
  await ingest(envelope(1), at, "pc");
  await expect(ingest(envelope(1, 5), at, "pc")).rejects.toThrow(
    "snapshot_conflict",
  );
});
it("keeps ordering across ingestor restart and strips secret fields", async () => {
  const store = createMemoryStore();
  await createUsageIngestor(store, { claude: "pc" })(
    { ...envelope(5), secret: "hidden" } as UsageEnvelope,
    at,
    "pc",
  );
  expect(
    await createUsageIngestor(store, { claude: "pc" })(envelope(4), at, "pc"),
  ).toBe("older");
  expect(JSON.stringify(await store.readSnapshot())).not.toContain("hidden");
});
it("sender only sends changes or heartbeat and coalesces concurrent calls", async () => {
  let calls = 0;
  const sender = createSender(async () => {
    calls++;
  });
  await Promise.all([sender(envelope(1), 0), sender(envelope(1), 0)]);
  await sender(envelope(1), 59000);
  expect(calls).toBe(1);
  await sender(envelope(1), 60000);
  expect(calls).toBe(2);
  await sender(envelope(2), 61000);
  expect(calls).toBe(3);
});
