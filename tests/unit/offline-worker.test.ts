import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
function worker(fail = false) {
  const handlers: Record<string, (event: any) => void> = {};
  const stored = new Map<string, Response>();
  const deleted: string[] = [];
  let skipped = 0;
  const pending: Promise<unknown>[] = [];
  const caches = {
    open: async () => ({
      addAll: async () => {
        if (fail) throw Error("missing_asset");
      },
      put: async (key: string, value: Response) => {
        stored.set(key, value);
      },
      match: async (key: string) => stored.get(key),
    }),
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
    keys: async () => ["fire-shell-previous", "unrelated-cache"],
  };
  const self = {
    location: { origin: "https://dashboard.example" },
    addEventListener: (type: string, fn: (event: any) => void) =>
      (handlers[type] = fn),
    skipWaiting: async () => {
      skipped++;
    },
    clients: { claim: async () => {} },
  };
  runInNewContext(
    readFileSync("apps/dashboard/src/sw.ts", "utf8")
      .replace("__VERSION__", "test")
      .replace("__ASSETS__", JSON.stringify(["/index.html", "/font.woff2"])),
    { self, caches, Response, URL, fetch: async () => new Response("network") },
  );
  return {
    dispatch: (type: string, extra: Record<string, unknown> = {}) => {
      handlers[type]({
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        ...extra,
      });
      return Promise.all(pending);
    },
    deleted,
    stored,
    getSkipped: () => skipped,
    handlers,
  };
}
it("does not activate a partially installed offline shell", async () => {
  const w = worker(true);
  await expect(w.dispatch("install")).rejects.toThrow("missing_asset");
  expect(w.stored.has("/__complete__")).toBe(false);
  expect(w.deleted).toEqual(["fire-shell-test"]);
  expect(w.getSkipped()).toBe(0);
});
it("only activates complete updates after explicit action and preserves unrelated caches", async () => {
  const w = worker();
  await w.dispatch("install");
  expect(w.stored.has("/__complete__")).toBe(true);
  expect(w.getSkipped()).toBe(0);
  await w.dispatch("message", { data: "ACTIVATE_UPDATE" });
  expect(w.getSkipped()).toBe(1);
  await w.dispatch("activate");
  expect(w.deleted).toEqual(["fire-shell-previous"]);
});
it("never caches authenticated API responses or external content", () => {
  const w = worker();
  let intercepted = false;
  for (const url of [
    "https://dashboard.example/api/v1/dashboard",
    "https://evil.example/x",
  ])
    w.handlers.fetch({
      request: { url, method: "GET" },
      respondWith: () => {
        intercepted = true;
      },
    });
  expect(intercepted).toBe(false);
});
