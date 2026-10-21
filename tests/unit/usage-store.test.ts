import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileUsageStore } from "../../services/usage/src/store";
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
