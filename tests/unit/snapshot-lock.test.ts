import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { captureSnapshot } from "../../collectors/shared/snapshot";
import { emptyUsage } from "../../packages/contracts/src/index";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function snapshotPath() {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-lock-"));
  directories.push(dir);
  return join(dir, "usage.json");
}
async function deadPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}
async function ownerLock(path: string, pid: number, host = hostname()) {
  const token = randomUUID();
  const lock = path + ".lock";
  await mkdir(lock);
  const owner = join(lock, token + ".json");
  await writeFile(
    owner,
    JSON.stringify({ version: 1, pid, hostname: host, token }),
  );
  return { lock, owner };
}

it("recovers a confirmed-dead local owner and preserves snapshot sequence", async () => {
  const path = await snapshotPath();
  const first = await captureSnapshot(emptyUsage("codex"), path, "pc");
  await ownerLock(path, await deadPid());
  const next = await captureSnapshot(
    { ...emptyUsage("codex"), status: "error", errorCode: "network" },
    path,
    "pc",
  );
  expect(next.sequence).toBe(first.sequence + 1);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(next);
  await expect(readdir(path + ".lock")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("never reclaims a live owner even when the lock is old", async () => {
  const path = await snapshotPath();
  const { lock, owner } = await ownerLock(path, process.pid);
  await utimes(lock, new Date(0), new Date(0));
  await utimes(owner, new Date(0), new Date(0));
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "pc"),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(owner, "utf8")).pid).toBe(process.pid);
  await expect(readFile(path, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("does not use a local PID to reclaim another host's lock", async () => {
  const path = await snapshotPath();
  const { owner } = await ownerLock(path, await deadPid(), "different-host");
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "pc"),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(owner, "utf8")).hostname).toBe(
    "different-host",
  );
});

it.each(["missing", "corrupt", "extra-file"])(
  "fails closed on %s owner metadata",
  async (kind) => {
    const path = await snapshotPath();
    const { lock, owner } = await ownerLock(path, await deadPid());
    if (kind === "missing") await rm(owner);
    if (kind === "corrupt") await writeFile(owner, "{");
    if (kind === "extra-file")
      await writeFile(join(lock, "unexpected"), "keep");
    const before = await readdir(lock);
    await expect(
      captureSnapshot(emptyUsage("codex"), path, "pc"),
    ).rejects.toThrow();
    expect(await readdir(lock)).toEqual(before);
  },
);

it("concurrent recovery keeps each accepted changed snapshot sequence unique", async () => {
  const path = await snapshotPath();
  await ownerLock(path, await deadPid());
  const attempts = await Promise.allSettled(
    Array.from({ length: 24 }, (_, i) =>
      captureSnapshot(
        {
          ...emptyUsage("codex"),
          capturedAt: null,
          sourceAlias: `source-${i}`,
        },
        path,
        `source-${i}`,
      ),
    ),
  );
  const accepted = attempts.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  expect(accepted.length).toBeGreaterThan(0);
  expect(new Set(accepted.map((value) => value.sequence)).size).toBe(
    accepted.length,
  );
  const final = JSON.parse(await readFile(path, "utf8"));
  expect(final.sequence).toBe(accepted.length);
  expect(
    (await captureSnapshot(emptyUsage("codex"), path, "next")).sequence,
  ).toBe(final.sequence + 1);
});

async function holdingWorker(path: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/snapshot-lock-worker.ts", path],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(child, "exit");
  const [message] = (await once(child, "message")) as [{ state: string }];
  return { child, exited, state: message.state };
}

it("recovers after a real lock owner is killed", async () => {
  const path = await snapshotPath();
  const worker = await holdingWorker(path);
  try {
    expect(worker.state).toBe("acquired");
    const [filename] = await readdir(path + ".lock");
    const owner = JSON.parse(
      await readFile(join(path + ".lock", filename), "utf8"),
    );
    expect(owner.pid).toBe(worker.child.pid);
    worker.child.kill("SIGKILL");
    await worker.exited;
    expect(
      (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
    ).toBe(1);
  } finally {
    worker.child.kill("SIGKILL");
    await worker.exited;
  }
});

it("concurrent processes recovering a dead owner leave exactly one live holder", async () => {
  const path = await snapshotPath();
  await ownerLock(path, await deadPid());
  const workers = await Promise.all(
    Array.from({ length: 8 }, () => holdingWorker(path)),
  );
  try {
    const acquired = workers.filter((worker) => worker.state === "acquired");
    expect(acquired).toHaveLength(1);
    const [filename] = await readdir(path + ".lock");
    const owner = JSON.parse(
      await readFile(join(path + ".lock", filename), "utf8"),
    );
    expect(owner.pid).toBe(acquired[0].child.pid);
    // A long-running owner remains protected even with an arbitrarily old mtime.
    await utimes(path + ".lock", new Date(0), new Date(0));
    await expect(
      captureSnapshot(emptyUsage("codex"), path, "pc"),
    ).rejects.toThrow();
    expect(
      JSON.parse(await readFile(join(path + ".lock", filename), "utf8")).pid,
    ).toBe(owner.pid);
    acquired[0].child.send("release");
    await acquired[0].exited;
    expect(
      (await captureSnapshot(emptyUsage("codex"), path, "pc")).sequence,
    ).toBe(1);
  } finally {
    for (const worker of workers) worker.child.kill("SIGKILL");
    await Promise.all(workers.map((worker) => worker.exited));
  }
});

it.each(["EPERM", "EACCES", "UNKNOWN"])(
  "does not reclaim when process probing fails with %s",
  async (code) => {
    const path = await snapshotPath();
    const { owner } = await ownerLock(path, await deadPid());
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("probe failed"), { code });
    });
    try {
      await expect(
        captureSnapshot(emptyUsage("codex"), path, "pc"),
      ).rejects.toThrow();
      expect(await readFile(owner, "utf8")).toBeTruthy();
    } finally {
      probe.mockRestore();
    }
  },
);

it("releases its lock after invalid stored snapshot data", async () => {
  const path = await snapshotPath();
  await writeFile(path, "{");
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "pc"),
  ).rejects.toThrow("storage");
  await expect(readdir(path + ".lock")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects owner metadata with a non-string identity token", async () => {
  const path = await snapshotPath();
  const { owner } = await ownerLock(path, await deadPid());
  const metadata = JSON.parse(await readFile(owner, "utf8"));
  await writeFile(
    owner,
    JSON.stringify({ ...metadata, token: [metadata.token] }),
  );
  await expect(
    captureSnapshot(emptyUsage("codex"), path, "pc"),
  ).rejects.toThrow();
  expect(await readFile(owner, "utf8")).toBeTruthy();
});
