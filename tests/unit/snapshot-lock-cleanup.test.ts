import { afterEach, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  rm,
  stat,
  lstat,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireSnapshotLock } from "../../collectors/shared/snapshot-lock";
import { captureSnapshot } from "../../collectors/shared/snapshot";
import { startCodexCollector } from "../../collectors/codex/monitor";
import { captureClaude } from "../../collectors/claude/statusline";
import { emptyUsage } from "../../packages/contracts/src/index";

// Keep real filesystem operations except the individual failure under test:
// Linux cannot naturally reproduce Windows delete-pending handle semantics.
vi.mock("node:fs/promises", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...fs,
    rmdir: vi.fn(fs.rmdir),
    rename: vi.fn(fs.rename),
    unlink: vi.fn(fs.unlink),
    writeFile: vi.fn(fs.writeFile),
    lstat: vi.fn(fs.lstat),
    readFile: vi.fn(fs.readFile),
  };
});
const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(rmdir).mockReset().mockImplementation(actualFs.rmdir);
  vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
  vi.mocked(unlink).mockReset().mockImplementation(actualFs.unlink);
  vi.mocked(writeFile).mockReset().mockImplementation(actualFs.writeFile);
  vi.mocked(lstat).mockReset().mockImplementation(actualFs.lstat);
  vi.mocked(readFile).mockReset().mockImplementation(actualFs.readFile);
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function snapshotPath() {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-cleanup-"));
  directories.push(dir);
  return join(dir, "usage.json");
}
function fsError(code: string) {
  return Object.assign(new Error(code), { code });
}
async function staleOwner(path: string) {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const pid = child.pid!;
  await once(child, "exit");
  const token = randomUUID();
  await mkdir(path + ".lock");
  await writeFile(
    join(path + ".lock", token + ".json"),
    JSON.stringify({ version: 1, pid, hostname: hostname(), token }),
  );
}

it.each(["EPERM", "ENOTEMPTY"])(
  "retries transient %s during normal release without losing the saved result",
  async (code) => {
    const path = await snapshotPath();
    vi.mocked(rmdir).mockRejectedValueOnce(fsError(code));
    const saved = await captureSnapshot(emptyUsage("codex"), path, "pc");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
    await expect(readdir(path + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await captureSnapshot(emptyUsage("codex"), path, "next")).sequence,
    ).toBe(saved.sequence + 1);
  },
);

it.each(["EPERM", "ENOTEMPTY"])(
  "retries transient %s during dead-owner recovery",
  async (code) => {
    const path = await snapshotPath();
    await staleOwner(path);
    vi.mocked(rmdir).mockRejectedValueOnce(fsError(code));
    expect(
      (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
    ).toBe(1);
    await expect(readdir(path + ".lock")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("bounds persistent cleanup retries and lets the next call recover without waiting for this PID to exit", async () => {
  const path = await snapshotPath();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const saved = await captureSnapshot(emptyUsage("codex"), path, "pc");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
  expect(vi.mocked(rmdir).mock.calls.length).toBe(5);
  expect(await readdir(path + ".lock")).toHaveLength(1);
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "next")).sequence,
  ).toBe(saved.sequence + 1);
});

it("leaves recoverable metadata after permanent dead-owner recovery failure", async () => {
  const path = await snapshotPath();
  await staleOwner(path);
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "pc"),
  ).rejects.toThrow();
  expect(vi.mocked(rmdir).mock.calls.length).toBe(5);
  expect(await readdir(path + ".lock")).toHaveLength(1);
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
  ).toBe(1);
});

it("does not replace the original write error with a release error", async () => {
  const path = await snapshotPath();
  const originalError = new Error("snapshot_write_failed");
  vi.mocked(rename).mockRejectedValueOnce(originalError);
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  await expect(captureSnapshot(emptyUsage("codex"), path, "pc")).rejects.toBe(
    originalError,
  );
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not retry against or restore metadata into a replacement initializing directory", async () => {
  const path = await snapshotPath();
  const lock = path + ".lock";
  let replacementInode: number | undefined;
  vi.mocked(rmdir).mockImplementationOnce(async (target) => {
    await actualFs.rename(target, lock + ".previous");
    await mkdir(lock);
    replacementInode = (await stat(lock)).ino;
    throw fsError("EPERM");
  });
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
  ).toBe(1);
  expect((await stat(lock)).ino).toBe(replacementInode);
  expect(await readdir(lock)).toEqual([]);
  expect(vi.mocked(rmdir).mock.calls.length).toBe(1);
});

it("concurrent callers recovering a deferred release keep unique snapshot sequences", async () => {
  const path = await snapshotPath();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const first = await captureSnapshot(emptyUsage("codex"), path, "first");
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, (_, i) =>
      captureSnapshot(emptyUsage("codex"), path, `source-${i}`),
    ),
  );
  const saved = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  expect(saved.length).toBeGreaterThan(0);
  expect(new Set(saved.map((value) => value.sequence)).size).toBe(saved.length);
  expect(JSON.parse(await readFile(path, "utf8")).sequence).toBe(
    first.sequence + saved.length,
  );
});

it("reports deferred cleanup separately from a saved snapshot", async () => {
  const path = await snapshotPath();
  const onCleanupError = vi.fn();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const saved = await captureSnapshot(emptyUsage("codex"), path, "pc", {
    onCleanupError,
  });
  expect(saved.sequence).toBe(1);
  expect(onCleanupError).toHaveBeenCalledOnce();
});

it("does not let a cleanup observer replace the saved result", async () => {
  const path = await snapshotPath();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const onCleanupError = () => {
    throw new Error("observer_failed");
  };
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "pc", { onCleanupError }))
      .sequence,
  ).toBe(1);
});

it("sends a saved Codex snapshot while reporting cleanup instead of storage failure", async () => {
  const path = await snapshotPath();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const categories: string[] = [];
  let finish!: (value: unknown) => void;
  const sent = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = startCodexCollector({
    path,
    sourceAlias: "pc",
    read: async () => emptyUsage("codex"),
    onError: (category) => categories.push(category),
    send: async (value) => {
      finish(value);
    },
  });
  try {
    expect(await sent).toEqual(JSON.parse(await readFile(path, "utf8")));
    expect(categories).toEqual(["cleanup"]);
  } finally {
    stop();
  }
});

it("reports Claude cleanup failure separately without rejecting its capture", async () => {
  const path = await snapshotPath();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const onCleanupError = vi.fn();
  const saved = await captureClaude(
    {},
    "2026-10-02T00:00:00.000Z",
    path,
    "pc",
    { onCleanupError },
  );
  expect(saved.sequence).toBe(1);
  expect(onCleanupError).toHaveBeenCalledOnce();
});

it("uses a fresh recovery identity while an old owner filename is delete-pending", async () => {
  const path = await snapshotPath();
  let pendingFile: Parameters<typeof unlink>[0] | undefined;
  vi.mocked(unlink).mockImplementation(async (target) => {
    if (!pendingFile && dirname(String(target)) === path + ".lock") {
      pendingFile = target;
      return; // Model successful unlink whose open handle delays final removal.
    }
    return actualFs.unlink(target);
  });
  const saved = await captureSnapshot(emptyUsage("codex"), path, "pc");
  const entries = await readdir(path + ".lock");
  expect(entries).toHaveLength(2);
  const markers = await Promise.all(
    entries.map(async (entry) =>
      JSON.parse(await readFile(join(path + ".lock", entry), "utf8")),
    ),
  );
  expect(markers.filter((owner) => owner.released === true)).toHaveLength(1);
  expect(new Set(markers.map((owner) => owner.token)).size).toBe(2);
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "next"),
  ).rejects.toThrow("snapshot_locked");
  await actualFs.unlink(pendingFile!); // The other process closes its handle.
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "next")).sequence,
  ).toBe(saved.sequence + 1);
});

it("makes recovery-marker write failure observable without losing saved data or reclaiming an empty lock", async () => {
  const path = await snapshotPath();
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  vi.mocked(writeFile).mockImplementation(async (target, data, options) => {
    if (String(data).includes('"released":true')) throw fsError("EACCES");
    return actualFs.writeFile(target, data, options);
  });
  const onCleanupError = vi.fn();
  const saved = await captureSnapshot(emptyUsage("codex"), path, "pc", {
    onCleanupError,
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
  expect(onCleanupError).toHaveBeenCalledOnce();
  expect(await readdir(path + ".lock")).toEqual([]);
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "next"),
  ).rejects.toThrow("snapshot_locked");
});

it("releases its initializing directory when writing owner metadata fails before file creation", async () => {
  const path = await snapshotPath();
  const originalError = fsError("EACCES");
  vi.mocked(writeFile).mockRejectedValueOnce(originalError);
  await expect(captureSnapshot(emptyUsage("codex"), path, "pc")).rejects.toBe(
    originalError,
  );
  await expect(readdir(path + ".lock")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
  ).toBe(1);
});

it("does not let an old release closure touch a replacement owner", async () => {
  const path = await snapshotPath();
  const release = await acquireSnapshotLock(path);
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  await expect(release()).rejects.toMatchObject({ code: "EPERM" });
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  const nextRelease = await acquireSnapshotLock(path);
  const before = await readdir(path + ".lock");
  await expect(release()).rejects.toMatchObject({ code: "EPERM" });
  expect(await readdir(path + ".lock")).toEqual(before);
  await nextRelease();
});

it("keeps a paused old-token reclaimer from deleting a replacement owner", async () => {
  const path = await snapshotPath();
  await staleOwner(path);
  const [oldName] = await readdir(path + ".lock");
  const oldPath = join(path + ".lock", oldName);
  let entered!: () => void, resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  vi.mocked(writeFile).mockImplementation(async (target, data, options) => {
    if (String(target) === oldPath.replace(/\.json$/, ".cleanup") && first) {
      first = false;
      entered();
      await gate;
    }
    return actualFs.writeFile(target, data, options);
  });
  const slow = captureSnapshot(emptyUsage("codex"), path, "slow");
  const rejected = expect(slow).rejects.toThrow();
  await paused;
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "fast"),
  ).rejects.toThrow();
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  const release = await acquireSnapshotLock(path);
  const replacement = await readdir(path + ".lock");
  resume();
  await rejected;
  expect(await readdir(path + ".lock")).toEqual(replacement);
  await release();
});

it("does not strand its own directory when birthtime falls back to changing ctime", async () => {
  const path = await snapshotPath();
  let timestamp = 0n;
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const value = await actualFs.lstat(...args);
    Object.defineProperty(value, "birthtimeNs", {
      value: timestamp++,
      configurable: true,
    });
    return value;
  });
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
  ).toBe(1);
  await expect(readdir(path + ".lock")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("grants one cleanup claim even when Windows could report two successful owner unlinks", async () => {
  const path = await snapshotPath();
  await staleOwner(path);
  const [ownerName] = await readdir(path + ".lock");
  const ownerPath = join(path + ".lock", ownerName);
  let observed = 0,
    allowBoth!: () => void;
  const bothObserved = new Promise<void>((resolve) => {
    allowBoth = resolve;
  });
  vi.mocked(readFile).mockImplementation(async (...args) => {
    const data = await actualFs.readFile(...args);
    if (String(args[0]) === ownerPath && observed < 2) {
      observed++;
      if (observed === 2) allowBoth();
      await bothObserved;
    }
    return data;
  });
  let ownerUnlinks = 0;
  let deletion: Promise<void> | undefined;
  vi.mocked(unlink).mockImplementation((target) => {
    if (String(target) !== ownerPath) return actualFs.unlink(target);
    ownerUnlinks++;
    // Model two already-open Windows handles both returning successful delete.
    return (deletion ??= actualFs.unlink(target));
  });
  vi.mocked(rmdir).mockRejectedValue(fsError("EPERM"));
  const results = await Promise.allSettled([
    captureSnapshot(emptyUsage("codex"), path, "one"),
    captureSnapshot(emptyUsage("codex"), path, "two"),
  ]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(ownerUnlinks).toBe(1);
  expect(await readdir(path + ".lock")).toHaveLength(1);
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "next")).sequence,
  ).toBe(1);
});
