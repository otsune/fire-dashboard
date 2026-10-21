import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CODEX_USAGE_ENDPOINT,
  fetchCodexUsage,
  normalizeCodexApi,
  readCodexOAuthToken,
} from "../../collectors/codex/api";

const at = "2026-10-16T00:00:00.000Z";
const usage = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 42.5, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 0, reset_after_seconds: 86400 },
    unlimited: false,
  },
  account: { email: "private@example.test", access_token: "SECRET" },
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

it("normalizes only the Codex API rate-limit windows", () => {
  const value = normalizeCodexApi(usage, at);
  expect(value).toMatchObject({
    provider: "codex",
    status: "ok",
    capturedAt: at,
    sourceObservedAt: null,
  });
  expect(value.buckets).toEqual([
    {
      id: "rate_limits",
      label: "Codex",
      windows: [
        {
          id: "primary_window",
          label: "5時間",
          usedPercent: 42.5,
          windowMinutes: 300,
          resetsAt: "2026-10-16T01:00:00.000Z",
        },
        {
          id: "secondary_window",
          label: "7日間",
          usedPercent: 0,
          windowMinutes: 10080,
          resetsAt: "2026-10-17T00:00:00.000Z",
        },
      ],
    },
  ]);
  expect(JSON.stringify(value)).not.toMatch(/SECRET|private@|plus/);
});

it("classifies Codex windows by duration and prefers an absolute reset time", () => {
  const value = normalizeCodexApi(
    {
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 604800,
          reset_at: 1792195200,
          reset_after_seconds: 1,
        },
        secondary_window: { used_percent: 10, limit_window_seconds: 18000 },
      },
    },
    at,
  );
  expect(value.buckets[0].windows).toMatchObject([
    {
      id: "primary_window",
      label: "7日間",
      windowMinutes: 10080,
      resetsAt: "2026-10-17T00:00:00.000Z",
    },
    { id: "secondary_window", label: "5時間", windowMinutes: 300 },
  ]);
  expect(
    normalizeCodexApi(
      {
        rate_limit: {
          primary_window: { used_percent: 1, limit_window_seconds: 123 },
        },
      },
      at,
    ).buckets[0].windows[0],
  ).toMatchObject({ label: "利用枠", windowMinutes: null });
});

it("keeps malformed values nullable and reports absent windows", () => {
  expect(
    normalizeCodexApi(
      {
        rate_limit: {
          primary_window: {
            used_percent: 101,
            reset_after_seconds: -1,
          },
        },
      },
      at,
    ).buckets[0].windows[0],
  ).toMatchObject({ usedPercent: null, resetsAt: null });
  expect(normalizeCodexApi({}, at)).toMatchObject({
    status: "missing",
    buckets: [],
  });
});

describe("Codex usage API fetcher", () => {
  it("uses the fixed endpoint and does not expose the token", async () => {
    const fetcher = vi.fn(async () => jsonResponse(usage));
    const value = await fetchCodexUsage({
      capturedAt: at,
      oauthToken: "synthetic-token",
      fetch: fetcher,
    });
    expect(value).toEqual(normalizeCodexApi(usage, at));
    expect(fetcher).toHaveBeenCalledWith(
      CODEX_USAGE_ENDPOINT,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: "Bearer synthetic-token",
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(value)).not.toContain("synthetic-token");
  });

  it.each([
    [401, "auth", "error"],
    [403, "auth", "error"],
    [404, "unsupported", "unsupported"],
    [429, "rate_limited", "error"],
    [500, "network", "error"],
  ] as const)("maps HTTP %s safely", async (code, errorCode, status) => {
    const value = await fetchCodexUsage({
      capturedAt: at,
      oauthToken: "synthetic-token",
      fetch: async () => jsonResponse({ message: "SECRET" }, code),
    });
    expect(value).toMatchObject({ status, errorCode, buckets: [] });
    expect(JSON.stringify(value)).not.toMatch(/SECRET|synthetic-token/);
  });

  it("rejects absent credentials and bounds a stalled request", async () => {
    const fetcher = vi.fn();
    expect(
      await fetchCodexUsage({
        capturedAt: at,
        credentialsPath: "/tmp/does-not-exist-codex-auth.json",
        fetch: fetcher,
      }),
    ).toMatchObject({ status: "unconfigured", errorCode: "unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();

    const timeout = await fetchCodexUsage({
      capturedAt: at,
      oauthToken: "synthetic-token",
      timeoutMs: 5,
      fetch: () => new Promise<Response>(() => {}),
    });
    expect(timeout.errorCode).toBe("timeout");
  });
});

describe("Codex credentials", () => {
  it("reads tokens.access_token and falls back to the supplied API key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-api-"));
    const path = join(dir, "auth.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          tokens: { access_token: "oauth-token", id_token: "wrong-token" },
        }),
      );
      expect(await readCodexOAuthToken(path)).toBe("oauth-token");
      await writeFile(path, "not-json");
      expect(await readCodexOAuthToken(path, "api-key-fallback")).toBe(
        "api-key-fallback",
      );
      expect(await readCodexOAuthToken(path, "bad token")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
