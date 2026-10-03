import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexService } from "../../collectors/codex/service";
import {
  emptyCommon,
  emptyUsage,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});
async function setup(token: string) {
  const dir = await mkdtemp(join(tmpdir(), "fire-codex-service-"));
  dirs.push(dir);
  await writeFile(join(dir, "token"), token + "\n");
  return {
    FIRE_SNAPSHOT_PATH: join(dir, "codex.json"),
    FIRE_SOURCE_ALIAS: "gmktec",
    FIRE_ENDPOINT: "https://dash.example/api/v1/usage",
    FIRE_COLLECTOR_TOKEN_FILE: join(dir, "token"),
  };
}
const read = async () => ({
  ...emptyUsage("codex"),
  ...emptyCommon("ok"),
  capturedAt: new Date().toISOString(),
});
it("refuses to start without its configuration", () => {
  expect(() => startCodexService({})).toThrow("unconfigured");
});
it("sends the snapshot with the bearer token read from its file", async () => {
  const env = await setup("t".repeat(43));
  const sent: { url: string; auth: string; body: UsageEnvelope }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      sent.push({
        url: String(url),
        auth: (init.headers as Record<string, string>).authorization,
        body: JSON.parse(String(init.body)),
      });
      return new Response("{}", { status: 200 });
    }),
  );
  const stop = startCodexService(env, { read, log: () => {} });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  stop();
  expect(sent[0].url).toBe("https://dash.example/api/v1/usage");
  expect(sent[0].auth).toBe(`Bearer ${"t".repeat(43)}`);
  expect(sent[0].body.sourceAlias).toBe("gmktec");
  expect(sent[0].body.payload.provider).toBe("codex");
});
it("does not send with a malformed token and logs only the category", async () => {
  const env = await setup("short");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const logs: string[] = [];
  const stop = startCodexService(env, { read, log: (l) => logs.push(l) });
  await vi.waitFor(() => expect(logs).toHaveLength(1));
  stop();
  expect(fetch).not.toHaveBeenCalled();
  expect(logs[0]).toBe("Fire Dashboard codex collector: send failed");
});
