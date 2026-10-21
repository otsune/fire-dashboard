import { expect, it } from "vitest";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { createUsageIngestorWithRevision } from "../../services/usage/src/ingest";
import { at, usageEnvelope } from "../helpers/usage";

it("keeps latest good observations and pins duplicate observation time across PCs", async () => {
  const store = createMemoryUsageStore();
  const ingest = createUsageIngestorWithRevision(store, {
    claude: ["desk", "note"],
  });
  const desk = usageEnvelope(1);
  await ingest(desk, at(1), "desk");
  await ingest(usageEnvelope(2, "note", 60), at(2), "note");
  await ingest(desk, at(3), "desk");
  expect(
    (await store.readDelivery()).usage.find((u) => u.provider === "claude")
      ?.sourceAlias,
  ).toBe("note");
  const failure = usageEnvelope(3, "desk", null);
  failure.payload.status = "error";
  failure.payload.errorCode = "network";
  await ingest(failure, at(3), "desk");
  expect(
    (await store.readDelivery()).usage.find((u) => u.provider === "claude")
      ?.buckets[0].windows[0].usedPercent,
  ).toBe(60);
  await expect(
    ingest(usageEnvelope(1, "note"), at(4), "note"),
  ).resolves.toEqual({ status: "older", revisionChanged: false });
  await expect(
    ingest(usageEnvelope(2, "note", 61), at(4), "note"),
  ).rejects.toThrow("snapshot_conflict");
  await expect(ingest(desk, at(4), "note")).rejects.toThrow("source_denied");
  const ownFailure = usageEnvelope(3, "note", null);
  ownFailure.payload.status = "error";
  await ingest(ownFailure, at(4), "note");
  const shown = (await store.readDelivery()).usage.find(
    (u) => u.provider === "claude",
  )!;
  expect(shown.status).toBe("error");
  expect(shown.buckets[0].windows[0].usedPercent).toBe(60);
  expect(shown.lastSuccessAt).toBe(at(2));
});
