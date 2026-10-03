import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStore,
  createMemoryStore,
  type Store,
} from "../../services/aggregator/src/store";
import { createUsageIngestor } from "../../services/aggregator/src/usage/ingest";
import {
  emptyUsage,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
const time = (minute: number) => `2026-10-02T00:0${minute}:00.000Z`;
function envelope(
  alias: string,
  sequence: number,
  error = false,
): UsageEnvelope {
  return {
    sourceAlias: alias,
    sequence,
    snapshotId: `${alias}-${sequence}`,
    payload: {
      ...emptyUsage("hermes_nous"),
      sourceAlias: alias,
      status: error ? "error" : "ok",
      errorCode: error ? "network" : null,
      capturedAt: time(error ? 1 : 0),
      sourceObservedAt: time(0),
      buckets: error
        ? []
        : [
            {
              id: "quota",
              label: "Quota",
              windows: [
                {
                  id: "month",
                  label: "Month",
                  usedPercent: 80,
                  windowMinutes: null,
                  resetsAt: time(9),
                },
              ],
            },
          ],
      ...(error
        ? {}
        : {
            balance: {
              currency: "USD" as const,
              subscriptionRemaining: 35,
              purchasedRemaining: 0,
              totalRemaining: 35,
              monthlyAllowance: 175,
              renewsAt: time(9),
            },
          }),
    },
  };
}
const send = (
  store: Store,
  alias: string,
  value: UsageEnvelope,
  minute: number,
) =>
  createUsageIngestor(store, { hermes_nous: alias })(
    value,
    time(minute),
    alias,
  );
async function seed(store: Store) {
  await send(store, "a", envelope("a", 1), 0);
  await send(store, "a", envelope("a", 2, true), 1);
  return (await store.readSnapshot()).usage.find(
    (u) => u.provider === "hermes_nous",
  )!;
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function file() {
  const dir = await mkdtemp(join(tmpdir(), "usage-replay-"));
  directories.push(dir);
  return join(dir, "state.json");
}
it("error heartbeats update receipt without advancing the last success", async () => {
  const store = createMemoryStore();
  const retained = await seed(store);
  expect(await send(store, "a", envelope("a", 2, true), 3)).toBe("duplicate");
  expect(
    (await store.readSnapshot()).usage.find(
      (u) => u.provider === "hermes_nous",
    ),
  ).toEqual({ ...retained, receivedAt: time(3) });
});
it.each([false, true])(
  "restores an errored source's effective values after switching (restart=%s)",
  async (restart) => {
    const path = await file();
    let store = createFileStore(path);
    const retained = await seed(store);
    await send(store, "b", envelope("b", 1), 2);
    if (restart) store = createFileStore(path);
    expect(await send(store, "a", envelope("a", 2, true), 3)).toBe("duplicate");
    expect(
      (await store.readSnapshot()).usage.find(
        (u) => u.provider === "hermes_nous",
      ),
    ).toEqual({ ...retained, receivedAt: time(3) });
    expect(await send(store, "a", envelope("a", 3, true), 4)).toBe("accepted");
    expect(
      (await store.readSnapshot()).usage.find(
        (u) => u.provider === "hermes_nous",
      ),
    ).toEqual({ ...retained, receivedAt: time(4) });
  },
);
it("migrates a legacy displayed error before a different source replaces it", async () => {
  const path = await file();
  const store = createFileStore(path);
  const retained = await seed(store);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.usageValues;
  await writeFile(path, JSON.stringify(legacy));
  await send(createFileStore(path), "b", envelope("b", 1), 2);
  await send(createFileStore(path), "a", envelope("a", 2, true), 3);
  expect(
    (await createFileStore(path).readSnapshot()).usage.find(
      (u) => u.provider === "hermes_nous",
    ),
  ).toEqual({ ...retained, receivedAt: time(3) });
});
it("does not invent a success time for an error without prior good data", async () => {
  const store = createMemoryStore();
  const error = envelope("a", 1, true);
  error.payload.lastSuccessAt = time(0);
  await send(store, "a", error, 1);
  await send(store, "a", error, 3);
  expect(
    (await store.readSnapshot()).usage.find((u) => u.provider === "hermes_nous")
      ?.lastSuccessAt,
  ).toBeNull();
});
it("successful replay preserves success time across a source switch", async () => {
  const store = createMemoryStore();
  await send(store, "a", envelope("a", 1), 0);
  const retained = (await store.readSnapshot()).usage.find(
    (u) => u.provider === "hermes_nous",
  )!;
  await send(store, "b", envelope("b", 1), 2);
  await send(store, "a", envelope("a", 1), 3);
  expect(
    (await store.readSnapshot()).usage.find(
      (u) => u.provider === "hermes_nous",
    ),
  ).toEqual({ ...retained, receivedAt: time(3) });
});
it("legacy off-screen errors do not borrow another source's data or invent a success", async () => {
  const path = await file();
  const store = createFileStore(path);
  await seed(store);
  await send(store, "b", envelope("b", 1), 2);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.usageValues;
  await writeFile(path, JSON.stringify(legacy));
  await send(createFileStore(path), "a", envelope("a", 2, true), 3);
  const value = (await createFileStore(path).readSnapshot()).usage.find(
    (u) => u.provider === "hermes_nous",
  )!;
  expect(value.buckets).toEqual([]);
  expect(value.balance).toBeUndefined();
  expect(value.lastSuccessAt).toBeNull();
  expect(value.receivedAt).toBe(time(3));
});
it("keeps raw error payload conflict detection and sequence ordering after restoring values", async () => {
  const store = createMemoryStore();
  await seed(store);
  await send(store, "b", envelope("b", 1), 2);
  await send(store, "a", envelope("a", 2, true), 3);
  const retained = await store.readSnapshot();
  await expect(send(store, "a", envelope("a", 2), 4)).rejects.toThrow(
    "snapshot_conflict",
  );
  const changedId = envelope("a", 2, true);
  changedId.snapshotId = "changed";
  await expect(send(store, "a", changedId, 4)).rejects.toThrow(
    "snapshot_conflict",
  );
  expect(await send(store, "a", envelope("a", 1), 4)).toBe("older");
  expect(await store.readSnapshot()).toEqual(retained);
});
it("a newer success replaces the retained error value", async () => {
  const store = createMemoryStore();
  await seed(store);
  await send(store, "b", envelope("b", 1), 2);
  const fresh = envelope("a", 3);
  fresh.payload.buckets[0].windows[0].usedPercent = 0;
  fresh.payload.balance!.totalRemaining = 0;
  await send(store, "a", fresh, 4);
  expect(
    (await store.readSnapshot()).usage.find(
      (u) => u.provider === "hermes_nous",
    ),
  ).toEqual({ ...fresh.payload, receivedAt: time(4), lastSuccessAt: time(4) });
});
it("preserves recoverable legacy success with unknown success time through repeated errors and restart", async () => {
  const path = await file();
  const store = createFileStore(path);
  await send(store, "a", envelope("a", 1), 0);
  await send(store, "b", envelope("b", 1), 2);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.usageValues;
  await writeFile(path, JSON.stringify(legacy));
  await send(createFileStore(path), "a", envelope("a", 1), 3);
  for (const sequence of [2, 3]) {
    await send(
      createFileStore(path),
      "a",
      envelope("a", sequence, true),
      sequence + 2,
    );
    const value = (await createFileStore(path).readSnapshot()).usage.find(
      (u) => u.provider === "hermes_nous",
    )!;
    expect(value.balance?.totalRemaining).toBe(35);
    expect(value.buckets[0].windows[0].usedPercent).toBe(80);
    expect(value.lastSuccessAt).toBeNull();
    expect(value.capturedAt).toBe(time(0));
  }
});
it("recovers legacy off-screen success when the next envelope is a newer error", async () => {
  const path = await file();
  const store = createFileStore(path);
  await send(store, "a", envelope("a", 1), 0);
  await send(store, "b", envelope("b", 1), 2);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  delete legacy.usageValues;
  await writeFile(path, JSON.stringify(legacy));
  await send(createFileStore(path), "a", envelope("a", 2, true), 3);
  const value = (await createFileStore(path).readSnapshot()).usage.find(
    (u) => u.provider === "hermes_nous",
  )!;
  expect(value.balance?.totalRemaining).toBe(35);
  expect(value.buckets[0].windows[0].usedPercent).toBe(80);
  expect(value.lastSuccessAt).toBeNull();
  expect(value.receivedAt).toBe(time(3));
  expect(value.capturedAt).toBe(time(0));
});
