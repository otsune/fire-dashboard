import { it, expect } from "vitest";
import { fetchOpenCodeGo } from "../../collectors/opencode-go/adapter";
import { envelopeSchema } from "../../packages/contracts/src/index";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { createUsageIngestor } from "../../services/aggregator/src/usage/ingest";

const capturedAt = "2026-10-02T12:00:00.000Z";
const receivedAt = "2026-10-02T12:00:01.000Z";
const failedAt = "2026-10-02T12:01:00.000Z";
const failedReceipt = "2026-10-02T12:01:01.000Z";
const alias = "go-test-source";

it.each([null, "2026-10-02T11:59:00.000Z"])(
  "keeps the last known Go snapshot with observation %s after HTTP 403",
  async (sourceObservedAt) => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, { opencode_go: alias });
    // All values are synthetic. Also cover observation metadata in a prior
    // accepted snapshot, even though the current endpoint supplies no timestamp.
    const success = await fetchOpenCodeGo({
      capturedAt,
      apiKey: "synthetic-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            usage: {
              rolling: {
                status: "ok",
                percent: 37,
                resetsAt: "2026-10-02T17:00:00.000Z",
              },
            },
          }),
        ),
    });
    expect(success.status).toBe("ok");
    await ingest(
      envelopeSchema.parse({
        snapshotId: "go-success",
        sequence: 1,
        sourceAlias: alias,
        payload: { ...success, sourceAlias: alias, sourceObservedAt },
      }),
      receivedAt,
      alias,
    );
    const previous = (await store.readSnapshot()).usage.find(
      (value) => value.provider === "opencode_go",
    );
    expect(previous?.buckets[0].windows[0].usedPercent).toBe(37);

    const forbidden = await fetchOpenCodeGo({
      capturedAt: failedAt,
      apiKey: "synthetic-key",
      fetch: async () =>
        new Response("SECRET account identifier", { status: 403 }),
    });
    expect(
      await ingest(
        envelopeSchema.parse({
          snapshotId: "go-forbidden",
          sequence: 2,
          sourceAlias: alias,
          payload: { ...forbidden, sourceAlias: alias },
        }),
        failedReceipt,
        alias,
      ),
    ).toBe("accepted");

    const current = (await store.readSnapshot()).usage.find(
      (value) => value.provider === "opencode_go",
    );
    expect(current).toEqual({
      ...previous,
      status: "error",
      errorCode: "auth",
      receivedAt: failedReceipt,
    });
    expect(JSON.stringify(current)).not.toMatch(/SECRET|synthetic-key/);
  },
);
