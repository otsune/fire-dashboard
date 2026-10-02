import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createUsageIngestor } from "../../services/aggregator/src/usage/ingest";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { createServer } from "../../services/aggregator/src/server";
import { configSchema, parsePort } from "../../services/aggregator/src/config";
import { createTailscaleAuth } from "../../services/aggregator/src/auth-tailscale";
import {
  emptyUsage,
  emptyCommon,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
function envelope(
  alias: string,
  sequence: number,
  percent: number,
  capturedAt: string,
  status: "ok" | "error" = "ok",
): UsageEnvelope {
  return {
    snapshotId: `${alias}-${sequence}`,
    sequence,
    sourceAlias: alias,
    payload: {
      ...emptyUsage("claude"),
      ...emptyCommon(status),
      ...(status === "error" ? { errorCode: "network" as const } : {}),
      sourceAlias: alias,
      capturedAt,
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
const t = (m: number) => new Date(Date.UTC(2026, 9, 3, 0, m)).toISOString();
async function shown(store: ReturnType<typeof createMemoryStore>) {
  const u = (await store.readSnapshot()).usage.find(
    (v) => v.provider === "claude",
  )!;
  return {
    alias: u.sourceAlias,
    percent: u.buckets[0]?.windows[0].usedPercent,
  };
}
describe("multiple collector PCs", () => {
  it("accepts every listed alias and shows the freshest capture", async () => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, { claude: ["desk", "note"] });
    await ingest(envelope("desk", 1, 30, t(0)), t(0), "desk");
    await ingest(envelope("note", 1, 40, t(5)), t(5), "note");
    expect(await shown(store)).toEqual({ alias: "note", percent: 40 });
    // A PC waking from sleep must not roll the display back.
    await ingest(envelope("desk", 2, 35, t(3)), t(6), "desk");
    expect(await shown(store)).toEqual({ alias: "note", percent: 40 });
    await ingest(envelope("desk", 3, 45, t(7)), t(7), "desk");
    expect(await shown(store)).toEqual({ alias: "desk", percent: 45 });
  });
  it("keeps per-PC sequences independent", async () => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, { claude: ["desk", "note"] });
    expect(await ingest(envelope("desk", 9, 30, t(0)), t(0), "desk")).toBe(
      "accepted",
    );
    expect(await ingest(envelope("note", 1, 31, t(1)), t(1), "note")).toBe(
      "accepted",
    );
    expect(await ingest(envelope("desk", 8, 30, t(2)), t(2), "desk")).toBe(
      "older",
    );
  });
  it("does not let another PC's failure hide working numbers", async () => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, { claude: ["desk", "note"] });
    await ingest(envelope("desk", 1, 30, t(0)), t(0), "desk");
    await ingest(envelope("note", 1, 0, t(5), "error"), t(5), "note");
    const u = (await store.readSnapshot()).usage.find(
      (v) => v.provider === "claude",
    )!;
    expect(u.status).toBe("ok");
    expect(u.sourceAlias).toBe("desk");
    // The displayed PC's own failure is still reported.
    await ingest(envelope("desk", 2, 0, t(6), "error"), t(6), "desk");
    expect(
      (await store.readSnapshot()).usage.find((v) => v.provider === "claude")!
        .status,
    ).toBe("error");
  });
  it("clamps captures from clocks running ahead to their receipt", async () => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, { claude: ["desk", "note"] });
    await ingest(envelope("note", 1, 50, t(60)), t(1), "note");
    await ingest(envelope("desk", 1, 20, t(2)), t(2), "desk");
    expect(await shown(store)).toEqual({ alias: "desk", percent: 20 });
  });
  it("does not let a heartbeat of an older snapshot take over the display", async () => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, { claude: ["desk", "note"] });
    await ingest(envelope("desk", 1, 30, t(0)), t(0), "desk");
    await ingest(envelope("note", 1, 40, t(5)), t(5), "note");
    expect(await ingest(envelope("desk", 1, 30, t(0)), t(6), "desk")).toBe(
      "duplicate",
    );
    expect(await shown(store)).toEqual({ alias: "note", percent: 40 });
  });
  it("keeps an off-screen PC's last good data for when it returns to the display", async () => {
    const store = createMemoryStore();
    const both = createUsageIngestor(store, { claude: ["desk", "note"] });
    await both(envelope("desk", 1, 30, t(5)), t(5), "desk");
    // Older than the display: saved for "note" but not shown.
    await both(envelope("note", 1, 25, t(1)), t(6), "note");
    await both(envelope("note", 2, 0, t(7), "error"), t(7), "note");
    expect(await shown(store)).toEqual({ alias: "desk", percent: 30 });
    // "desk" leaves the configuration; note's unchanged error is resent.
    await createUsageIngestor(store, { claude: ["note"] })(
      envelope("note", 2, 0, t(7), "error"),
      t(8),
      "note",
    );
    const u = (await store.readSnapshot()).usage.find(
      (v) => v.provider === "claude",
    )!;
    expect(u.sourceAlias).toBe("note");
    expect(u.status).toBe("error");
    expect(u.buckets[0].windows[0].usedPercent).toBe(25);
    expect(u.lastSuccessAt).toBe(t(6));
  });
  it("lets a listed PC replace one removed from the configuration", async () => {
    const store = createMemoryStore();
    await createUsageIngestor(store, { claude: ["old"] })(
      envelope("old", 1, 30, t(5)),
      t(5),
      "old",
    );
    await createUsageIngestor(store, { claude: ["desk"] })(
      envelope("desk", 1, 20, t(1)),
      t(6),
      "desk",
    );
    expect(await shown(store)).toEqual({ alias: "desk", percent: 20 });
  });
  it("still rejects unlisted aliases", async () => {
    const ingest = createUsageIngestor(createMemoryStore(), {
      claude: ["desk"],
    });
    await expect(
      ingest(envelope("other", 1, 1, t(0)), t(0), "other"),
    ).rejects.toThrow("source_denied");
  });
  it("config accepts one alias or a list", () => {
    expect(
      configSchema.parse({ preferredSources: { claude: ["a", "b"] } })
        .preferredSources.claude,
    ).toEqual(["a", "b"]);
    expect(
      configSchema.parse({ preferredSources: { codex: "a" } }).preferredSources
        .codex,
    ).toBe("a");
    expect(() =>
      configSchema.parse({ preferredSources: { claude: ["bad alias"] } }),
    ).toThrow();
    expect(() =>
      configSchema.parse({ preferredSources: { claude: [] } }),
    ).toThrow();
  });
});
describe("FIRE_PORT", () => {
  it("defaults to 8787 and validates the range", () => {
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort("")).toBe(8787);
    expect(parsePort("18787")).toBe(18787);
    for (const bad of ["0", "65536", "80a", "-1", " 80", "123456"])
      expect(() => parsePort(bad)).toThrow("invalid_port");
  });
});
describe("Tailscale auth", () => {
  const token = "a".repeat(43);
  const hash = createHash("sha256").update(token).digest("hex");
  const auth = createTailscaleAuth({
    readerLogins: ["me@example.com"],
    collectorTokenHashes: { desk: hash },
  });
  const server = () =>
    createServer({
      store: createMemoryStore(),
      ...auth,
      allowedOrigins: ["https://dash.example"],
      preferredSources: { claude: ["desk"] },
    });
  it("lets the tailnet reader view but not post", async () => {
    const s = server();
    const view = await s.inject({
      url: "/api/v1/dashboard",
      headers: { "tailscale-user-login": "me@example.com" },
    });
    expect(view.statusCode).toBe(200);
    const post = await s.inject({
      url: "/api/v1/usage",
      method: "POST",
      headers: { "tailscale-user-login": "me@example.com" },
      payload: envelope("desk", 1, 1, t(0)),
    });
    // Authenticated as a reader, so the collector route is forbidden.
    expect(post.statusCode).toBe(403);
    await s.close();
  });
  it("rejects unknown logins and bearer tokens on reads", async () => {
    const s = server();
    for (const headers of [
      { "tailscale-user-login": "someone@else.com" },
      {},
      { authorization: `Bearer ${token}` },
    ]) {
      const r = await s.inject({ url: "/api/v1/dashboard", headers });
      expect(r.statusCode).not.toBe(200);
    }
    await s.close();
  });
  it("derives the collector alias from the token", async () => {
    const s = server();
    const ok = await s.inject({
      url: "/api/v1/usage",
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      payload: envelope("desk", 1, 1, t(0)),
    });
    expect(ok.statusCode).toBe(200);
    const wrong = await s.inject({
      url: "/api/v1/usage",
      method: "POST",
      headers: { authorization: `Bearer ${"b".repeat(43)}` },
      payload: envelope("desk", 2, 1, t(1)),
    });
    expect(wrong.statusCode).toBe(401);
    await s.close();
  });
  it("refuses empty or malformed configuration", () => {
    expect(() =>
      createTailscaleAuth({
        readerLogins: [],
        collectorTokenHashes: { desk: hash },
      }),
    ).toThrow();
    expect(() =>
      createTailscaleAuth({
        readerLogins: ["me@example.com"],
        collectorTokenHashes: { desk: "not-a-hash" },
      }),
    ).toThrow("invalid_collector_token");
  });
});
