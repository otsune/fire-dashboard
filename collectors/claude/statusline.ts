import { pathToFileURL } from "node:url";
import { extractClaude } from "./extract";
import { captureSnapshot } from "../shared/snapshot";
export async function captureClaude(
  stdin: unknown,
  capturedAt: string,
  path: string,
  sourceAlias: string,
  options: { onCleanupError?: () => void } = {},
) {
  return captureSnapshot(
    extractClaude(stdin, capturedAt),
    path,
    sourceAlias,
    options,
  );
}
async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH,
    alias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !alias) throw Error("unconfigured");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw Error("too_large");
  }
  await captureClaude(
    JSON.parse(input),
    new Date().toISOString(),
    path,
    alias,
    {
      onCleanupError: () =>
        process.stderr.write(
          "Fire Dashboard: snapshot lock cleanup deferred\n",
        ),
    },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: local snapshot unavailable\n");
    process.exitCode = 1;
  });
