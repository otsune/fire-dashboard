import { pathToFileURL } from "node:url";
import { fetchOpenCodeGo, type GoFetchOptions } from "./adapter";
import { captureSnapshot } from "../shared/snapshot";

export async function captureOpenCodeGo(
  options: GoFetchOptions & { path: string; sourceAlias: string },
) {
  return captureSnapshot(
    await fetchOpenCodeGo(options),
    options.path,
    options.sourceAlias,
  );
}
async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH,
    sourceAlias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !sourceAlias) throw Error("unconfigured");
  const result = await captureOpenCodeGo({
    path,
    sourceAlias,
    capturedAt: new Date().toISOString(),
    apiKey: process.env.OPENCODE_GO_API_KEY,
  });
  if (result.payload.status !== "ok") throw Error("unavailable");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: local snapshot unavailable\n");
    process.exitCode = 1;
  });
