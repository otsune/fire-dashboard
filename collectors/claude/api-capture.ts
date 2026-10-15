import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { fetchClaudeUsage, type ClaudeApiFetchOptions } from "./api";

export async function captureClaudeApi(
  options: ClaudeApiFetchOptions & {
    path: string;
    sourceAlias: string;
  },
) {
  return captureSnapshot(
    await fetchClaudeUsage(options),
    options.path,
    options.sourceAlias,
  );
}

async function main() {
  const path = process.env.FIRE_SNAPSHOT_PATH;
  const sourceAlias = process.env.FIRE_SOURCE_ALIAS;
  if (!path || !sourceAlias) throw Error("unconfigured");
  const snapshot = await captureClaudeApi({
    path,
    sourceAlias,
    capturedAt: new Date().toISOString(),
    credentialsPath: process.env.FIRE_CLAUDE_CREDENTIALS_FILE,
  });
  if (snapshot.payload.status !== "ok") throw Error("unavailable");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.stderr.write("Fire Dashboard: Claude usage unavailable\n");
    process.exitCode = 1;
  });
