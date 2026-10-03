/*
 * Long-running Codex collector: reads rate limits through `codex app-server`,
 * keeps the local snapshot, and sends it to the aggregator.
 * FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS: local snapshot and its alias.
 * FIRE_ENDPOINT: HTTPS URL of the aggregator's /api/v1/usage.
 * FIRE_COLLECTOR_TOKEN_FILE: file holding this collector's bearer token.
 * FIRE_POLL_SECONDS: read interval, 30-280 (default 60). Each read starts a
 * `codex app-server` (~0.5 s CPU), so longer is lighter; it must stay under
 * the dashboard's 5-minute "取得元に未接続" threshold, as every read also
 * refreshes the receipt time.
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
  const poll = env.FIRE_POLL_SECONDS ?? "60";
  if (!/^\d+$/.test(poll) || +poll < 30 || +poll > 280)
    throw Error("invalid_poll_seconds");
  const send = createHttpSender(new URL(endpoint), bearerFromFile(tokenFile));
  const log = deps.log ?? ((line) => process.stderr.write(line + "\n"));
  return startCodexCollector({
    path,
    sourceAlias: alias,
    send,
    read: deps.read,
    intervalMs: +poll * 1000,
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
      "Fire Dashboard codex collector: check FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS (letters, digits, - or _, 1-64 chars), FIRE_ENDPOINT, FIRE_COLLECTOR_TOKEN_FILE and FIRE_POLL_SECONDS (30-280)\n",
    );
    process.exitCode = 1;
  }
}
