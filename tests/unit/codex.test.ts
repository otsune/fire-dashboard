import { it, expect } from "vitest";
import { normalizeCodex } from "../../collectors/codex/adapter";
import {
  readLimitsWithTransport,
  type RpcTransport,
} from "../../collectors/codex/stdio";
const at = "2026-10-02T00:00:00.000Z";
it("prefers dynamic multibucket limits, nullable secondary and arbitrary windows", () => {
  const u = normalizeCodex(
    {
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          limitName: "Codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 15,
            resetsAt: 1790900000,
          },
          secondary: null,
        },
        other: {
          limitName: "Other",
          primary: { usedPercent: 42, windowDurationMins: 60 },
        },
      },
      token: "SECRET",
    },
    at,
  );
  expect(u.buckets.map((b) => b.id)).toEqual(["codex", "other"]);
  expect(u.buckets[0].windows).toHaveLength(1);
  expect(u.buckets[0].windows[0].windowMinutes).toBe(15);
  expect(u.buckets[0].windows[0].resetsAt).toBe(
    new Date(1790900000 * 1000).toISOString(),
  );
  expect(JSON.stringify(u)).not.toContain("SECRET");
});
it("supports the legacy rateLimits view and missing values", () => {
  expect(
    normalizeCodex(
      { rateLimits: { limitId: "codex", primary: { usedPercent: 0 } } },
      at,
    ).buckets[0].windows[0].usedPercent,
  ).toBe(0);
  expect(normalizeCodex({}, at).status).toBe("missing");
  expect(
    normalizeCodex(
      { rateLimitsByLimitId: { codex: { primary: { usedPercent: 999 } } } },
      at,
    ).buckets[0].windows[0].usedPercent,
  ).toBeNull();
});
it("uses only initialize/initialized/account rate read over transport", async () => {
  const sent: string[] = [];
  let listener: (value: unknown) => void = () => {};
  const t: RpcTransport = {
    send: (value) => {
      sent.push(value.method);
      queueMicrotask(() => {
        if (value.id === 0) listener({ id: 0, result: {} });
        if (value.id === 1)
          listener({
            id: 1,
            result: { rateLimits: { primary: { usedPercent: 10 } } },
          });
      });
    },
    listen: (callback) => {
      listener = callback;
      return () => {};
    },
    close: () => {},
  };
  const u = await readLimitsWithTransport(t, at);
  expect(u.buckets[0].windows[0].usedPercent).toBe(10);
  expect(sent).toEqual([
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
});
it("maps auth rejection safely without raw server error", async () => {
  let listener: (v: unknown) => void = () => {};
  const t: RpcTransport = {
    send: (v) =>
      queueMicrotask(() =>
        listener(
          v.id === 0
            ? { id: 0, result: {} }
            : { id: 1, error: { code: 401, message: "SECRET credential" } },
        ),
      ),
    listen: (cb) => {
      listener = cb;
      return () => {};
    },
    close: () => {},
  };
  const u = await readLimitsWithTransport(t, at);
  expect(u.errorCode).toBe("auth");
  expect(JSON.stringify(u)).not.toContain("SECRET");
});
it("classifies unsupported methods and missing responses safely", async () => {
  let listener: (v: unknown) => void = () => {};
  const unsupported: RpcTransport = {
    send: (v) =>
      queueMicrotask(() => listener({ id: v.id, error: { code: -32601 } })),
    listen: (cb) => {
      listener = cb;
      return () => {};
    },
    close: () => {},
  };
  expect((await readLimitsWithTransport(unsupported, at)).status).toBe(
    "unsupported",
  );
  const silent: RpcTransport = {
    send: () => {},
    listen: () => () => {},
    close: () => {},
  };
  expect((await readLimitsWithTransport(silent, at, 5)).errorCode).toBe(
    "timeout",
  );
});
