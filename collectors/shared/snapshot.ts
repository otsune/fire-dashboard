import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  envelopeSchema,
  type Usage,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
import { atomicJson } from "../../services/aggregator/src/store";
import { acquireSnapshotLock } from "./snapshot-lock";
export async function captureSnapshot(
  payload: Usage,
  path: string,
  sourceAlias: string,
): Promise<UsageEnvelope> {
  await mkdir(dirname(path), { recursive: true });
  const release = await acquireSnapshotLock(path);
  try {
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
    await release();
  }
}
