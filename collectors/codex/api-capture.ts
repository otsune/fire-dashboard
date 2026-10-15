import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { fetchCodexUsage, type CodexApiFetchOptions } from "./api";

export async function captureCodexApi(
  options: CodexApiFetchOptions & {
    path: string;
    sourceAlias: string;
  },
) {
  return captureSnapshot(
    await fetchCodexUsage(options),
    options.path,
    options.sourceAlias,
  );
}

async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH;
  const sourceAlias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !sourceAlias) throw Error("unconfigured");
  const snapshot = await captureCodexApi({
    path,
    sourceAlias,
    capturedAt: new Date().toISOString(),
    credentialsPath: process.env.FIRE_CODEX_CREDENTIALS_FILE,
    apiKey: process.env.OPENAI_API_KEY,
  });
  if (snapshot.payload.status !== "ok") throw Error("unavailable");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: Codex usage unavailable\n");
    process.exitCode = 1;
  });
