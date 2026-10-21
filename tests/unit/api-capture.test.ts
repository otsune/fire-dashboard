import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureClaudeApi } from "../../collectors/claude/api-capture";
import { captureCodexApi } from "../../collectors/codex/api-capture";
import { captureGrokUsage } from "../../collectors/grok/api-capture";
import { captureHermesNousApi } from "../../collectors/hermes-nous/api-capture";
it("persists only sanitized provider observations with the authorized alias through API capture entrypoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "api-capture-"));
  const capturedAt = "2026-10-22T00:00:00.000Z";
  try {
    const captures = [
      [
        "claude",
        (path: string) =>
          captureClaudeApi({
            path,
            sourceAlias: "desk",
            capturedAt,
            oauthToken: "synthetic-only",
            fetch: async () =>
              Response.json({
                five_hour: { utilization: 30 },
                email: "SECRET",
              }),
          }),
      ],
      [
        "codex",
        (path: string) =>
          captureCodexApi({
            path,
            sourceAlias: "desk",
            capturedAt,
            oauthToken: "synthetic-only",
            fetch: async () =>
              Response.json({
                rate_limit: { primary_window: { used_percent: 42 } },
                email: "SECRET",
              }),
          }),
      ],
      [
        "grok",
        (path: string) =>
          captureGrokUsage({
            path,
            sourceAlias: "desk",
            capturedAt,
            accessToken: "synthetic-only",
            fetch: async () => new Response("SECRET", { status: 401 }),
          }),
      ],
      [
        "hermes_nous",
        (path: string) => {
          const options = {
            path,
            sourceAlias: "desk",
            capturedAt,
            run: async () => ({
              available: true,
              balance: { total_remaining: 12 },
              email: "SECRET",
            }),
          };
          return captureHermesNousApi(options);
        },
      ],
    ] as const;
    for (const [provider, capture] of captures) {
      const path = join(dir, `${provider}.json`);
      await capture(path);
      const text = await readFile(path, "utf8"),
        saved = JSON.parse(text);
      expect(saved).toMatchObject({
        sourceAlias: "desk",
        sequence: 1,
        payload: { provider, sourceAlias: "desk", capturedAt },
      });
      expect(text).not.toMatch(/SECRET|synthetic-only/);
      if (provider === "grok") expect(saved.payload.errorCode).toBe("auth");
      else expect(saved.payload.status).toBe("ok");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
