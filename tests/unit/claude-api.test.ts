import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAUDE_USAGE_ENDPOINT,
  fetchClaudeUsage,
  normalizeClaudeApi,
  readClaudeOAuthToken,
} from "../../collectors/claude/api";

const at = "2026-10-16T00:00:00.000Z";
const reset = "2026-10-16T05:00:00.000Z";
const usage = {
  five_hour: { utilization: 40.3, resets_at: reset },
  seven_day: { utilization: 0, resets_at: "2026-10-22T00:00:00.000Z" },
  account: { email: "private@example.test", access_token: "SECRET" },
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

it("normalizes Anthropic OAuth usage windows without forwarding private fields", () => {
  const value = normalizeClaudeApi(usage, at);
  expect(value).toMatchObject({
    provider: "claude",
    status: "ok",
    capturedAt: at,
    sourceObservedAt: null,
  });
  expect(value.buckets[0].windows).toEqual([
    {
      id: "five_hour",
      label: "5時間",
      usedPercent: 40.3,
      windowMinutes: 300,
      resetsAt: reset,
    },
    {
      id: "seven_day",
      label: "7日間",
      usedPercent: 0,
      windowMinutes: 10080,
      resetsAt: "2026-10-22T00:00:00.000Z",
    },
  ]);
  expect(JSON.stringify(value)).not.toMatch(/SECRET|private@|account/);
});

it("does not fabricate a window when the API response has no supported windows", () => {
  expect(normalizeClaudeApi({}, at)).toMatchObject({
    status: "missing",
    buckets: [],
  });
  expect(
    normalizeClaudeApi(
      { five_hour: { utilization: 101, resets_at: "not-a-date" } },
      at,
    ).buckets[0].windows[0],
  ).toMatchObject({ usedPercent: null, resetsAt: null });
});

describe("Claude OAuth API fetcher", () => {
  it("uses only the fixed endpoint and does not expose the token in usage", async () => {
    const fetcher = vi.fn(async () => jsonResponse(usage));
    const value = await fetchClaudeUsage({
      capturedAt: at,
      oauthToken: "synthetic-token",
      fetch: fetcher,
    });
    expect(value).toEqual(normalizeClaudeApi(usage, at));
    expect(fetcher).toHaveBeenCalledWith(
      CLAUDE_USAGE_ENDPOINT,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: "Bearer synthetic-token",
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(value)).not.toContain("synthetic-token");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [500, "network"],
  ] as const)(
    "maps HTTP %s to %s without retaining the body",
    async (code, errorCode) => {
      const response = jsonResponse({ message: "SECRET" }, code);
      const value = await fetchClaudeUsage({
        capturedAt: at,
        oauthToken: "synthetic-token",
        fetch: async () => response,
      });
      expect(value).toMatchObject({ status: "error", errorCode, buckets: [] });
      expect(JSON.stringify(value)).not.toMatch(/SECRET|synthetic-token/);
    },
  );

  it("rejects absent credentials before making a request and bounds a stalled request", async () => {
    const fetcher = vi.fn();
    expect(
      await fetchClaudeUsage({
        capturedAt: at,
        credentialsPath: "/tmp/does-not-exist-claude-credentials.json",
        fetch: fetcher,
      }),
    ).toMatchObject({ status: "unconfigured", errorCode: "unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();

    const timeout = await fetchClaudeUsage({
      capturedAt: at,
      oauthToken: "synthetic-token",
      timeoutMs: 5,
      fetch: () => new Promise<Response>(() => {}),
    });
    expect(timeout.errorCode).toBe("timeout");
  });
});

describe("Claude Code credentials", () => {
  it("reads only claudeAiOauth.accessToken", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-api-"));
    const path = join(dir, "credentials.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-token" },
          mcpOAuth: { accessToken: "wrong-token" },
        }),
      );
      expect(await readClaudeOAuthToken(path)).toBe("oauth-token");
      await writeFile(path, "not-json");
      expect(await readClaudeOAuthToken(path)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
