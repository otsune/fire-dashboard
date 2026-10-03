import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startSnapshotSender } from "../../collectors/shared/send-service";
import { captureClaude } from "../../collectors/claude/statusline";
import type { UsageEnvelope } from "../../packages/contracts/src/index";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "fire-sender-"));
  dirs.push(dir);
  await writeFile(join(dir, "token"), "t".repeat(43));
  return {
    dir,
    env: {
      FIRE_SNAPSHOT_PATHS: [
        join(dir, "claude.json"),
        join(dir, "none.json"),
      ].join(delimiter),
      FIRE_ENDPOINT: "https://dash.example/api/v1/usage",
      FIRE_COLLECTOR_TOKEN_FILE: join(dir, "token"),
    },
  };
}
function stubFetch() {
  const sent: UsageEnvelope[] = [];
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, fetch };
}
it("refuses to start without its configuration", () => {
  expect(() => startSnapshotSender({})).toThrow("unconfigured");
});
it("sends a statusline snapshot and resends unchanged ones only as heartbeat", async () => {
  const { dir, env } = await setup();
  await captureClaude(
    {
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 2000000000 },
      },
    },
    new Date().toISOString(),
    join(dir, "claude.json"),
    "win-desktop",
  );
  const { sent } = stubFetch();
  const logs: string[] = [];
  const stop = startSnapshotSender(env, {
    log: (l) => logs.push(l),
    pollMs: 5,
  });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  // Several more polls of the unchanged file stay within the heartbeat window.
  await new Promise((r) => setTimeout(r, 50));
  stop();
  expect(sent).toHaveLength(1);
  expect(sent[0].sourceAlias).toBe("win-desktop");
  expect(sent[0].payload.buckets[0].windows[0].usedPercent).toBe(42);
  // A missing file is normal before the first capture and is not logged.
  expect(logs).toEqual([]);
});
it("skips a corrupt snapshot without sending and logs only the category", async () => {
  const { dir, env } = await setup();
  await writeFile(join(dir, "claude.json"), "{not json");
  const { fetch } = stubFetch();
  const logs: string[] = [];
  const stop = startSnapshotSender(env, { log: (l) => logs.push(l) });
  await vi.waitFor(() => expect(logs).toHaveLength(1));
  stop();
  expect(fetch).not.toHaveBeenCalled();
  expect(logs[0]).toBe("Fire Dashboard sender: send failed");
});
