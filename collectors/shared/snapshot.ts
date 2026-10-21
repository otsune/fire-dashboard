import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  envelopeSchema,
  type Usage,
  type UsageEnvelope,
} from "../../packages/usage-contracts/src/index";
import { atomicJson } from "../../services/aggregator/src/store";
/**
 * A holder killed hard (kill -9, OOM) between lock and unlock would otherwise
 * wedge every later capture forever. The lock records its owning PID; a later
 * holder may reclaim the lock only once that PID no longer exists.
 */
async function reclaimStaleLock(lock: string): Promise<boolean> {
  let pidText: string;
  try {
    pidText = (await readFile(`${lock}/pid`, "utf8")).trim();
  } catch {
    // Unknown holder (legacy lock): never steal it.
    return false;
  }
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    // Signal 0 succeeding proves the PID exists; it may even be a different
    // process after PID reuse, in which case not unlocking is the safe side.
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
export async function captureSnapshot(
  payload: Usage,
  path: string,
  sourceAlias: string,
): Promise<UsageEnvelope> {
  await mkdir(dirname(path), { recursive: true });
  const lock = path + ".lock";
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw Error("storage");
    if (!(await reclaimStaleLock(lock))) throw Error("storage");
    await rm(lock, { recursive: true, force: true }).catch(() => {});
    await mkdir(lock).catch(() => {
      throw Error("storage");
    });
  }
  try {
    await writeFile(`${lock}/pid`, `${process.pid}\n`, { mode: 0o600 });
    let previous: UsageEnvelope | null = null;
    try {
      previous = envelopeSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error("storage");
    }
    const normalized = { ...payload, sourceAlias };
    const compare = (u: Usage) =>
      JSON.stringify({
        ...u,
        capturedAt: null,
        receivedAt: null,
        lastSuccessAt: null,
      });
    if (previous && compare(previous.payload) === compare(normalized))
      return previous;
    if (previous && previous.sequence >= Number.MAX_SAFE_INTEGER)
      throw Error("sequence_exhausted");
    const value = envelopeSchema.parse({
      sourceAlias,
      snapshotId: randomUUID(),
      sequence: (previous?.sequence ?? 0) + 1,
      payload: normalized,
    });
    await atomicJson(path, value);
    return value;
  } finally {
    // Swallow the removal error: the snapshot itself is durable, and a
    // transient failure here must not report the capture as failed. Cleanup
    // happens on the next holder's stale-lock reclaim instead.
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}
