import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractLegacyUsage,
  mergeUsageIntoLegacy,
  migrateUsageFile,
} from "../../services/usage/src/migrate";
import { emptyDashboard } from "../../packages/contracts/src/index";
import { createFileStore } from "../../services/aggregator/src/store";
import { createUsageIngestor } from "../helpers/legacy-usage";
import { createFileUsageStore } from "../../services/usage/src/store";
import { createUsageIngestorWithRevision } from "../../services/usage/src/ingest";
import { at, usageEnvelope } from "../helpers/usage";

it("migrates all source state without overwriting files and restores the newest observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-migrate-"));
  try {
    const source = join(dir, "legacy.json"),
      target = join(dir, "usage.json");
    const legacy = createFileStore(source);
    const ingest = createUsageIngestor(legacy, { claude: ["desk", "note"] });
    await ingest(usageEnvelope(2), at(2), "desk");
    await ingest(usageEnvelope(1, "note", 10), at(3), "note");
    const before = await readFile(source, "utf8");
    await migrateUsageFile({ from: source, to: target });
    expect(await readFile(source, "utf8")).toBe(before);
    const store = createFileUsageStore(target);
    const migrated = await store.readState(),
      old = JSON.parse(before);
    expect(migrated.delivery.streamId).toBe(old.streamId);
    expect(migrated.delivery.revision).toBe(old.usageRevision);
    expect(
      migrated.usageValues["claude:note"].buckets[0].windows[0].usedPercent,
    ).toBe(10);
    await createUsageIngestorWithRevision(store, { claude: ["desk", "note"] })(
      usageEnvelope(3, "desk", 70),
      at(4),
      "desk",
    );
    const latest = await store.readState();
    const restored = mergeUsageIntoLegacy(old, latest) as typeof old;
    expect(restored.dashboard.weather).toEqual(old.dashboard.weather);
    expect(restored.dashboard.rss).toEqual(old.dashboard.rss);
    expect(
      restored.dashboard.usage.find((u: any) => u.provider === "claude")
        .buckets[0].windows[0].usedPercent,
    ).toBe(70);
    expect(restored.usageRevision).toBe(latest.delivery.revision);
    const saved = await readFile(target, "utf8");
    await expect(
      migrateUsageFile({ from: source, to: target }),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(saved);
    await writeFile(source, "{}");
    await expect(
      migrateUsageFile({ from: source, to: target }),
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(saved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("supports pre-delivery snapshots but refuses inconsistent metadata and corrupt source keys", () => {
  const old = {
    dashboard: emptyDashboard(),
    usageSequences: {},
    usageValues: {},
  };
  const state = extractLegacyUsage(old);
  expect(state.delivery.revision).toBe("0");
  expect(state.delivery.streamId).toBeTruthy();
  expect(() =>
    extractLegacyUsage({
      ...old,
      usageValues: { "claude:wrong": usageEnvelope(1).payload },
    }),
  ).toThrow();
  expect(() =>
    extractLegacyUsage({
      ...old,
      streamId: "s",
      usageRevision: "1",
      usagePublishedAt: at(0),
      dashboard: {
        ...old.dashboard,
        usageDelivery: {
          schemaVersion: 1,
          streamId: "other",
          revision: "2",
          publishedAt: at(0),
        },
      },
    }),
  ).toThrow();
});
