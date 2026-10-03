/*
 * Long-running Codex collector: reads rate limits through `codex app-server`,
 * keeps the local snapshot, and sends it to the aggregator.
 * FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS: local snapshot and its alias.
 * FIRE_ENDPOINT: HTTPS URL of the aggregator's /api/v1/usage.
 * FIRE_COLLECTOR_TOKEN_FILE: file holding this collector's bearer token.
 */
import { pathToFileURL } from "node:url";
import { startCodexCollector } from "./monitor";
import { bearerFromFile, createHttpSender } from "../shared/sender";
import type { Usage } from "../../packages/contracts/src/index";
export function startCodexService(
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
  // Same rule as the envelope schema; otherwise every capture would fail
  // later as a storage error and nothing would ever be sent.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) throw Error("invalid_alias");
  const send = createHttpSender(new URL(endpoint), bearerFromFile(tokenFile));
  const log = deps.log ?? ((line) => process.stderr.write(line + "\n"));
  return startCodexCollector({
    path,
    sourceAlias: alias,
    send,
    read: deps.read,
    // Categories only: error details may contain account data.
    onError: (category) =>
      log(`Fire Dashboard codex collector: ${category} failed`),
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const stop = startCodexService(process.env);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "Fire Dashboard codex collector: check FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS (letters, digits, - or _, 1-64 chars), FIRE_ENDPOINT and FIRE_COLLECTOR_TOKEN_FILE\n",
    );
    process.exitCode = 1;
  }
}
