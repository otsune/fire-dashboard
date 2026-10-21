import { startPollLoop } from "../shared/poll";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { bearerFromFile, createHttpSender } from "../shared/sender";
import type { Usage } from "../../packages/usage-contracts/src/index";
import { fetchClaudeUsage } from "./api";

export function startClaudeApiService(
  env: Record<string, string | undefined>,
  deps: {
    read?: () => Promise<Usage>;
    log?: (line: string) => void;
  } = {},
): () => void {
  const path = env.FIRE_SNAPSHOT_PATH;
  const alias = env.FIRE_SOURCE_ALIAS;
  const endpoint = env.FIRE_ENDPOINT;
  const tokenFile = env.FIRE_COLLECTOR_TOKEN_FILE;
  if (!path || !alias || !endpoint || !tokenFile) throw Error("unconfigured");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) throw Error("invalid_alias");
  const poll = env.FIRE_POLL_SECONDS ?? "60";
  if (!/^\d+$/.test(poll) || +poll < 30 || +poll > 240)
    throw Error("invalid_poll_seconds");

  const credentialsPath =
    env.FIRE_CLAUDE_CREDENTIALS_FILE ??
    join(homedir(), ".claude", ".credentials.json");
  const send = createHttpSender(new URL(endpoint), bearerFromFile(tokenFile));
  const read =
    deps.read ??
    (() =>
      fetchClaudeUsage({
        capturedAt: new Date().toISOString(),
        credentialsPath,
      }));
  const log = deps.log ?? ((line) => process.stderr.write(line + "\n"));
  return startPollLoop(async (active) => {
    let value: Usage;
    try {
      value = await read();
    } catch {
      log("Fire Dashboard Claude API collector: read failed");
      return;
    }
    try {
      if (!active()) return;
      const envelope = await captureSnapshot(value, path, alias);
      if (!active()) return;
      await send(envelope);
    } catch {
      log("Fire Dashboard Claude API collector: storage or send failed");
    }
  }, +poll * 1000);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const stop = startClaudeApiService(process.env);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "Fire Dashboard Claude API collector: check FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS, FIRE_ENDPOINT, FIRE_COLLECTOR_TOKEN_FILE and FIRE_POLL_SECONDS\n",
    );
    process.exitCode = 1;
  }
}
