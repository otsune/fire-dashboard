import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchCodexUsage } from "./api";
import { startCodexCollector } from "./monitor";
import { bearerFromFile, createHttpSender } from "../shared/sender";
import type { Usage } from "../../packages/contracts/src/index";

/**
 * Long-running Codex API collector. Keep its snapshot path separate from the
 * App Server collector; two writers would otherwise race the same sequence.
 */
export function startCodexApiService(
  env: Record<string, string | undefined>,
  deps: {
    read?: () => Promise<Usage>;
    log?: (line: string) => void;
  } = {},
): () => void {
  const path = env.FIRE_SNAPSHOT_PATH,
    alias = env.FIRE_SOURCE_ALIAS,
    endpoint = env.FIRE_ENDPOINT,
    tokenFile = env.FIRE_COLLECTOR_TOKEN_FILE;
  if (!path || !alias || !endpoint || !tokenFile) throw Error("unconfigured");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) throw Error("invalid_alias");
  const poll = env.FIRE_POLL_SECONDS ?? "60";
  if (!/^\d+$/.test(poll) || +poll < 30 || +poll > 280)
    throw Error("invalid_poll_seconds");

  const credentialsPath =
    env.FIRE_CODEX_CREDENTIALS_FILE ?? join(homedir(), ".codex", "auth.json");
  const send = createHttpSender(new URL(endpoint), bearerFromFile(tokenFile));
  const read =
    deps.read ??
    (() =>
      fetchCodexUsage({
        capturedAt: new Date().toISOString(),
        credentialsPath,
        apiKey: env.OPENAI_API_KEY,
      }));
  const log = deps.log ?? ((line) => process.stderr.write(line + "\n"));
  return startCodexCollector({
    path,
    sourceAlias: alias,
    send,
    read,
    intervalMs: +poll * 1000,
    onError: (category) =>
      log(`Fire Dashboard codex API collector: ${category} failed`),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const stop = startCodexApiService(process.env);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "Fire Dashboard codex API collector: check FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS (letters, digits, - or _, 1-64 chars), FIRE_ENDPOINT, FIRE_COLLECTOR_TOKEN_FILE and FIRE_POLL_SECONDS (30-280)\n",
    );
    process.exitCode = 1;
  }
}
