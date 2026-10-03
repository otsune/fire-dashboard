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
it("waits the configured interval between reads", async () => {
  vi.useFakeTimers();
  const path = await mkdtemp(join(tmpdir(), "codex-monitor-"));
  let reads = 0,
    sends = 0;
  const stop = startCodexCollector({
    path: join(path, "limits.json"),
    sourceAlias: "pc",
    read: async () => {
      reads++;
      return emptyUsage("codex");
    },
    send: async () => {
      sends++;
    },
    intervalMs: 240000,
  });
  try {
    // The next read is scheduled once the first cycle has been sent.
    await vi.waitFor(() => expect(sends).toBe(1));
    await vi.advanceTimersByTimeAsync(239000);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(reads).toBe(2));
  } finally {
    stop();
    vi.useRealTimers();
    await rm(path, { recursive: true, force: true });
  }
});
