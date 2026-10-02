import { pathToFileURL } from "node:url";
import { extractAntigravity } from "./extract";
import { readJsonInput } from "../shared/input";
import { captureSnapshot } from "../shared/snapshot";

export async function captureAntigravity(
  raw: unknown,
  capturedAt: string,
  path: string,
  sourceAlias: string,
) {
  return captureSnapshot(
    extractAntigravity(raw, capturedAt),
    path,
    sourceAlias,
  );
}
async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH,
    alias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !alias) throw Error("unconfigured");
  await captureAntigravity(
    await readJsonInput(process.stdin),
    new Date().toISOString(),
    path,
    alias,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: local snapshot unavailable\n");
    process.exitCode = 1;
  });
