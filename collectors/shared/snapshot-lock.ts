import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

type Owner = {
  version: 1;
  pid: number;
  hostname: string;
  token: string;
  released?: true;
};
const ownerName =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const cleanupAttempts = 5;

async function isSameDirectory(lock: string, identity: BigIntStats) {
  try {
    const current = await lstat(lock, { bigint: true });
    // birthtime may be changing ctime on filesystems without creation time.
    return (
      current.isDirectory() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    );
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function removeOwnedLock(
  lock: string,
  owner: Owner,
  identity: BigIntStats,
  initializing = false,
) {
  const ownerPath = join(lock, owner.token + ".json");
  const claim = join(lock, owner.token + ".cleanup");
  // wx / CREATE_NEW grants one cleanup owner even where two already-open
  // Windows handles could both report a successful unlink. Failed claimants
  // never remove this file. Per-token claims cannot block a new owner's claim.
  await writeFile(claim, "", { flag: "wx", mode: 0o600 });
  try {
    if (!initializing) {
      // Re-open after obtaining the claim: a delayed old-token claimant may
      // now be in a replacement directory. A delete-pending file cannot grant
      // ownership through a cached pre-claim read either.
      const current = JSON.parse(await readFile(ownerPath, "utf8")) as Owner;
      if (
        !current ||
        current.version !== owner.version ||
        current.token !== owner.token ||
        current.pid !== owner.pid ||
        current.hostname !== owner.hostname ||
        current.released !== owner.released
      )
        throw Error("snapshot_locked");
    }
    try {
      await unlink(ownerPath);
    } catch (error) {
      // The mkdir owner can clean up its own failed initialization even when
      // writeFile never created metadata. Reclaimers never get this exception.
      if (!initializing || code(error) !== "ENOENT") throw error;
    }
  } finally {
    // Exactly once, before parent cleanup; a late claimant may subsequently
    // create this old-token claim again, and we must never touch it afterward.
    await unlink(claim);
  }
  let failure: unknown;
  for (let attempt = 0; attempt < cleanupAttempts; attempt++) {
    if (!(await isSameDirectory(lock, identity))) return;
    try {
      await rmdir(lock); // Never recursively remove unknown/replacement contents.
      return;
    } catch (error) {
      if (code(error) === "ENOENT") return;
      failure = error;
      if (!["EPERM", "ENOTEMPTY", "EBUSY"].includes(code(error) ?? "")) break;
      if (attempt + 1 < cleanupAttempts) await delay(20);
    }
  }
  if (await isSameDirectory(lock, identity)) {
    // Windows can keep the unlinked filename delete-pending while a reader has
    // it open. Use a NEW token, never recreate that filename. All participants
    // reject the empty directory until this marker is published. This MUST be
    // our final filesystem mutation: a new contender may now recover it even
    // though this process is still alive. Partial/multiple entries fail closed.
    const released: Owner = { ...owner, token: randomUUID(), released: true };
    await writeFile(
      join(lock, released.token + ".json"),
      JSON.stringify(released),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  throw failure;
}

async function reclaimDeadOwner(lock: string): Promise<void> {
  // Missing/partial/legacy metadata is not proof of a crashed writer.
  // A local filesystem shared only within one host/PID namespace is required.
  const entries = await readdir(lock);
  if (entries.length !== 1 || !ownerName.test(entries[0]))
    throw Error("snapshot_locked");
  const ownerPath = join(lock, entries[0]);
  let owner: Owner;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch {
    throw Error("snapshot_locked");
  }
  if (
    !owner ||
    owner.version !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.hostname !== hostname() ||
    typeof owner.token !== "string" ||
    `${owner.token}.json` !== entries[0] ||
    (owner.released !== undefined && owner.released !== true)
  )
    throw Error("snapshot_locked");
  if (!owner.released) {
    try {
      process.kill(owner.pid, 0);
      throw Error("snapshot_locked");
    } catch (error) {
      // EPERM/unknown errors and reused live PIDs are inconclusive. Age alone
      // never permits taking an active lock.
      if (code(error) !== "ESRCH") throw Error("snapshot_locked");
    }
  }
  const identity = await lstat(lock, { bigint: true });
  await removeOwnedLock(lock, owner, identity);
}

export async function acquireSnapshotLock(
  path: string,
): Promise<() => Promise<void>> {
  const lock = path + ".lock";
  try {
    await mkdir(lock);
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
    try {
      await reclaimDeadOwner(lock);
    } catch (recoveryError) {
      // One new mkdir is safe after a competing release; it cannot replace an
      // existing owner's directory. Never use ENOENT as permission to rmdir.
      if (code(recoveryError) !== "ENOENT") throw recoveryError;
    }
    await mkdir(lock);
  }
  const identity = await lstat(lock, { bigint: true });
  const owner: Owner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
  };
  const ownerPath = join(lock, owner.token + ".json");
  try {
    await writeFile(ownerPath, JSON.stringify(owner), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await removeOwnedLock(lock, owner, identity, true).catch(() => {});
    throw error;
  }
  // Once a deferred-release marker is published, this closure has no authority
  // to touch the canonical path again, including on repeated calls.
  let releasing: Promise<void> | undefined;
  return () => (releasing ??= removeOwnedLock(lock, owner, identity));
}
