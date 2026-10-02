import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexCollector } from "../../collectors/codex/monitor";
import { emptyUsage } from "../../packages/contracts/src/index";
it("reads and sends a local normalized snapshot then allows shutdown", async () => {
  const path = await mkdtemp(join(tmpdir(), "codex-monitor-"));
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let sent = 0;
  const stop = startCodexCollector({
    path: join(path, "limits.json"),
    sourceAlias: "pc",
    read: async () => emptyUsage("codex"),
    send: async (value) => {
      expect(value.sourceAlias).toBe("pc");
      expect(value.payload.provider).toBe("codex");
      sent++;
      finish();
    },
  });
  try {
    await complete;
    expect(sent).toBe(1);
  } finally {
    stop();
    await rm(path, { recursive: true, force: true });
  }
});
