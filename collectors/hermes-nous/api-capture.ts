import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { fetchHermesNousUsage } from "./api";

export async function captureHermesNousApi(options: {
  capturedAt: string;
  path: string;
  sourceAlias: string;
  pythonPath?: string;
  timeoutMs?: number;
}) {
  return captureSnapshot(
    await fetchHermesNousUsage(options),
    options.path,
    options.sourceAlias,
  );
}

async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH;
  const sourceAlias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !sourceAlias) throw Error("unconfigured");
  const snapshot = await captureHermesNousApi({
    path,
    sourceAlias,
    capturedAt: new Date().toISOString(),
    pythonPath: process.env.FIRE_HERMES_PYTHON,
  });
  if (snapshot.payload.status !== "ok") throw Error("unavailable");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: Nous usage unavailable\n");
    process.exitCode = 1;
  });
