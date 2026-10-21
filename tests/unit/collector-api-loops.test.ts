import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClaudeApiService } from "../../collectors/claude/api-service";
import { startGrokApiService } from "../../collectors/grok/api-service";
import { startHermesNousApiService } from "../../collectors/hermes-nous/api-service";
import { startCodexApiService } from "../../collectors/codex/api-service";
import {
  emptyCommon,
  emptyUsage,
} from "../../packages/usage-contracts/src/index";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
for (const [name, start] of Object.entries({
  claude: startClaudeApiService,
  grok: startGrokApiService,
  nous: startHermesNousApiService,
  codex: startCodexApiService,
})) {
  it(`${name} keeps start-to-start cadence and stops without sending an in-flight observation`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-loop-"));
    let stop: (() => void) | undefined;
    try {
      const token = join(dir, "token");
      await writeFile(token, "t".repeat(43));
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-22T00:00:00.000Z"));
      let reads = 0,
        sends = 0;
      vi.stubGlobal("fetch", async () => {
        sends++;
        return new Response("{}");
      });
      const env = {
        FIRE_SNAPSHOT_PATH: join(dir, "snapshot.json"),
        FIRE_SOURCE_ALIAS: "desk",
        FIRE_ENDPOINT: "https://usage.example/api/v1/usage",
        FIRE_COLLECTOR_TOKEN_FILE: token,
        FIRE_POLL_SECONDS: "60",
      };
      expect(() =>
        start(
          { ...env, FIRE_POLL_SECONDS: "241" },
          { read: () => new Promise(() => {}) },
        ),
      ).toThrow("invalid_poll_seconds");
      const begin = Date.now();
      stop = start(env, {
        read: async () => {
          reads++;
          await new Promise((r) => setTimeout(r, 20000));
          return {
            ...emptyUsage("codex"),
            ...emptyCommon("ok"),
            capturedAt: new Date().toISOString(),
          };
        },
      });
      await vi.advanceTimersByTimeAsync(20000);
      await vi.waitFor(() => expect(sends).toBe(1));
      await vi.advanceTimersByTimeAsync(begin + 60000 - Date.now());
      expect(reads).toBe(2);
      stop();
      await vi.advanceTimersByTimeAsync(100000);
      expect(reads).toBe(2);
      expect(sends).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop?.();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
