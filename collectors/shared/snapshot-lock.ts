import {
  mkdir,
  readFile,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

type Owner = { version: 1; pid: number; hostname: string; token: string };
const ownerName =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

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
    `${owner.token}.json` !== entries[0]
  )
    throw Error("snapshot_locked");
  try {
    process.kill(owner.pid, 0);
    throw Error("snapshot_locked");
  } catch (error) {
    // EPERM and all unknown errors are inconclusive. A reused PID is also
    // deliberately treated as live; age alone never permits taking the lock.
    if (code(error) !== "ESRCH") throw Error("snapshot_locked");
  }
  // Only one contender can unlink this unique owner's file. Losers MUST NOT
  // rmdir the path: it might already belong to a replacement writer.
  await unlink(ownerPath);
  await rmdir(lock); // Never recursively remove unknown/replacement contents.
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
      // Another contender or the normal owner may already have released it.
      // One new mkdir is safe; it cannot replace an existing owner's directory.
      if (code(recoveryError) !== "ENOENT") throw recoveryError;
    }
    await mkdir(lock);
  }
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
    await unlink(ownerPath).catch(() => {});
    await rmdir(lock).catch(() => {});
    throw error;
  }
  return async () => {
    // Do not remove a lock unless this acquisition still owns its unique file.
    await unlink(ownerPath);
    await rmdir(lock);
  };
}
