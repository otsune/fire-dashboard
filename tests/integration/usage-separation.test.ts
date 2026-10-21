import { expect, it } from "vitest";
import { createUsageClient } from "../../services/aggregator/src/usage/client";
import { createServer } from "../../services/aggregator/src/server";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { createUsageServer } from "../../services/usage/src/server";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { emptyUsage } from "../../packages/usage-contracts/src/index";
import { usageEnvelope } from "../helpers/usage";

it("keeps collection independent of Fire and retains canonical values when the backend fails", async () => {
  const usageStore = createMemoryUsageStore();
  const backend = createUsageServer({ store: usageStore, authorize: async (req, role) => req.headers.authorization === `Bearer ${role}`, sourceAlias: async () => "desk", preferredSources: { claude: "desk" } });
  let down = false;
  const client = createUsageClient({ baseUrl: "http://127.0.0.1:8788", readerToken: "reader", fetch: async (url, opts) => {
    if (down) throw Error("offline");
    const response = await backend.inject({ url: new URL(String(url)).pathname, method: opts?.method as "GET" | "POST" ?? "GET", headers: opts?.headers as Record<string, string>, payload: opts?.body as string });
    return new Response(response.body, { status: response.statusCode });
  } });
  const fire = () => createServer({ store: createMemoryStore(), authorize: async () => true, sourceAlias: async () => "desk", usageClient: client });
  let app = fire();
  try {
    expect((await app.inject({ method: "POST", url: "/api/v1/usage", headers: { authorization: "Bearer collector" }, payload: usageEnvelope(1) })).statusCode).toBe(200);
    const first = (await app.inject({ url: "/api/v1/dashboard" })).json();
    expect(first.usageDelivery.revision).toBe("1");
    expect(first.usageConnection).toBe("connected");
    await app.close();
    expect((await backend.inject({ method: "POST", url: "/api/v1/usage", headers: { authorization: "Bearer collector" }, payload: usageEnvelope(2) })).statusCode).toBe(200);
    app = fire();
    const latest = (await app.inject({ url: "/api/v1/dashboard" })).json();
    expect(latest.usageDelivery.revision).toBe("2");
    down = true;
    const outage = (await app.inject({ url: "/api/v1/dashboard" })).json();
    expect(outage.usageConnection).toBe("unavailable");
    expect(outage.usage).toEqual(latest.usage);
    expect(outage.usageDelivery).toEqual(latest.usageDelivery);
    expect(outage).toHaveProperty("weather"); expect(outage).toHaveProperty("rss");
  } finally { await app.close(); await backend.close(); }
});

it("rejects unsafe destinations, redirects, malformed or oversized data and times out", async () => {
  for (const baseUrl of ["http://evil.example", "http://user:pass@127.0.0.1", "http://127.0.0.1/?url=evil", "http://127.0.0.1/#x"])
    expect(() => createUsageClient({ baseUrl, readerToken: "secret" })).toThrow();
  for (const response of [new Response("{}"), new Response("secret", { status: 401 }), new Response("redirect", { status: 302 }), new Response("x".repeat(100))]) {
    const c = createUsageClient({ baseUrl: "http://127.0.0.1:8788", readerToken: "secret", maxBytes: 64, fetch: async () => response });
    await expect(c.readDelivery()).rejects.toThrow();
  }
  const stalled = createUsageClient({ baseUrl: "http://127.0.0.1:8788", readerToken: "secret", timeoutMs: 20, fetch: async (_url, opts) => new Promise((_resolve, reject) => { opts!.signal!.addEventListener("abort", () => reject(Error("timeout"))); }) });
  await expect(stalled.readDelivery()).rejects.toThrow("timeout");
});

it("coalesces concurrent reads and never replaces a same-stream newer revision with an older one", async () => {
  let revision = "2", calls = 0;
  const c = createUsageClient({ baseUrl: "http://127.0.0.1:8788", readerToken: "secret", fetch: async () => {
    calls++; await new Promise(r => setTimeout(r, 5));
    return Response.json({ schemaVersion: 1, streamId: "s", revision, publishedAt: "2026-10-22T00:00:00.000Z", usage: [emptyUsage("claude")] });
  } });
  await Promise.all([c.readDelivery(), c.readDelivery()]); expect(calls).toBe(1);
  revision = "1"; expect((await c.readDelivery()).revision).toBe("2");
});
