import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../services/aggregator/src/server";
import {
  createMemoryStore,
  createFileStore,
} from "../../services/aggregator/src/store";
import { emptyDashboard } from "../../packages/contracts/src/index";
function app() {
  return createServer({
    store: createMemoryStore(),
    allowedOrigins: ["https://dashboard.example"],
    authorize: async (req, role) => req.headers["x-test-role"] === role,
    sourceAlias: async () => "test-source",
  });
}
it("requires auth and separates reader from collectors", async () => {
  const s = app();
  expect((await s.inject({ url: "/api/v1/dashboard" })).statusCode).toBe(401);
  expect(
    (
      await s.inject({
        url: "/api/v1/dashboard",
        headers: { "x-test-role": "reader" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await s.inject({
        url: "/api/v1/health",
        headers: { "x-test-role": "reader" },
      })
    ).json(),
  ).toEqual({ status: "ok", schemaVersion: 1 });
  expect(
    (
      await s.inject({
        method: "POST",
        url: "/api/v1/usage",
        headers: { "x-test-role": "reader" },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  await s.close();
});
it("rejects unknown origins and oversized bodies", async () => {
  const s = app();
  expect(
    (
      await s.inject({
        url: "/api/v1/dashboard",
        headers: { "x-test-role": "reader", origin: "https://evil.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await s.inject({
        url: "/api/v1/usage",
        method: "POST",
        headers: {
          "x-test-role": "collector",
          "content-type": "application/json",
        },
        payload: JSON.stringify({ x: "x".repeat(66000) }),
      })
    ).statusCode,
  ).toBe(413);
  await s.close();
});
it("fails closed without authorization configuration", () =>
  expect(() => createServer({ store: createMemoryStore() } as never)).toThrow(
    "authorization_required",
  ));
it("sets no-store, strict CSP and never reflects auth error text", async () => {
  const s = createServer({
    store: createMemoryStore(),
    authorize: async () => {
      throw Error("token=secret");
    },
  });
  const r = await s.inject({ url: "/api/v1/health" });
  expect(r.body).not.toContain("secret");
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
  await s.close();
});
it("retains the old atomic snapshot if replacement fails", async () => {
  const path = await mkdtemp(join(tmpdir(), "fire-store-"));
  try {
    const file = join(path, "state.json");
    const good = createFileStore(file);
    await good.writeSnapshot(emptyDashboard());
    const previous = await readFile(file, "utf8");
    const broken = createFileStore(file, {
      beforeRename: async () => {
        throw Error("interrupted");
      },
    });
    await expect(broken.writeSnapshot(emptyDashboard())).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(previous);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
