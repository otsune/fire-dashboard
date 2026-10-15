import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { fetchGrokUsage, type GrokApiFetchOptions } from "./api";

export async function captureGrokUsage(
  options: GrokApiFetchOptions & { path: string; sourceAlias: string },
) {
  return captureSnapshot(
    await fetchGrokUsage(options),
    options.path,
    options.sourceAlias,
  );
}

async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH;
  const sourceAlias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !sourceAlias) throw Error("unconfigured");
  const snapshot = await captureGrokUsage({
    path,
    sourceAlias,
    capturedAt: new Date().toISOString(),
    credentialsPath: process.env.FIRE_GROK_CREDENTIALS_FILE,
  });
  if (snapshot.payload.status !== "ok") throw Error("unavailable");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: Grok usage unavailable\n");
    process.exitCode = 1;
  });
