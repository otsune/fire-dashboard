import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFileUsageStore,
  beginUsageSession,
} from "../../services/usage/src/store";
import { createUsageIngestorWithRevision } from "../../services/usage/src/ingest";
import { at, usageEnvelope } from "../helpers/usage";

it("persists independent usage state across restarts and preserves it on failed replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-store-"));
  try {
    const path = join(dir, "state.json");
    const store = createFileUsageStore(path);
    const ingest = createUsageIngestorWithRevision(store, {
      claude: ["desk", "note"],
    });
    await Promise.all([
      ingest(usageEnvelope(1), at(1), "desk"),
      ingest(usageEnvelope(2, "note", 50), at(2), "note"),
    ]);
    const state = await store.readState();
    expect(state.delivery.revision).toBe("2");
    expect(
      state.delivery.usage.find((u) => u.provider === "claude")?.sourceAlias,
    ).toBe("note");
    expect(await createFileUsageStore(path).readState()).toEqual(state);
    const before = await readFile(path, "utf8");
    expect(JSON.parse(before)).not.toHaveProperty("dashboard");
    const broken = createFileUsageStore(path, {
      beforeRename: async () => {
        throw Error("disk");
      },
    });
    await expect(
      broken.update((s) => ({ state: s, result: undefined })),
    ).rejects.toThrow("disk");
    expect(await readFile(path, "utf8")).toBe(before);
    await writeFile(path, "{}");
    await expect(createFileUsageStore(path).readState()).rejects.toThrow(
      "storage",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rotates the delivery stream on startup and on a live backup rollback while preserving source sequences", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-restore-"));
  try {
    const path = join(dir, "state.json");
    const store = createFileUsageStore(path);
    const ingest = createUsageIngestorWithRevision(store, { claude: "desk" });
    await ingest(usageEnvelope(1), at(1), "desk");
    const backup = await readFile(path, "utf8");
    await ingest(usageEnvelope(2), at(2), "desk");
    const before = await store.readDelivery();
    await writeFile(path, backup);
    const restored = await store.readState();
    expect(restored.delivery.streamId).not.toBe(before.streamId);
    expect(restored.delivery.revision).toBe("1");
    expect(restored.usageSequences["claude:desk"].sequence).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8")).delivery).toEqual(
      restored.delivery,
    );
    const restarted = createFileUsageStore(path);
    await beginUsageSession(restarted);
    const session = await restarted.readDelivery();
    expect(session.streamId).not.toBe(restored.delivery.streamId);
    expect(session.revision).toBe("1");
    expect(session.usage).toEqual(restored.delivery.usage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
