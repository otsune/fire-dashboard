import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { bearerFromFile, createHttpSender } from "../shared/sender";
import type { Usage } from "../../packages/usage-contracts/src/index";
import { fetchGrokUsage } from "./api";

export function startGrokApiService(
  env: Record<string, string | undefined>,
  deps: { read?: () => Promise<Usage>; log?: (line: string) => void } = {},
): () => void {
  const path = env.FIRE_SNAPSHOT_PATH;
  const alias = env.FIRE_SOURCE_ALIAS;
  const endpoint = env.FIRE_ENDPOINT;
  const tokenFile = env.FIRE_COLLECTOR_TOKEN_FILE;
  if (!path || !alias || !endpoint || !tokenFile) throw Error("unconfigured");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) throw Error("invalid_alias");
  const poll = env.FIRE_POLL_SECONDS ?? "60";
  if (!/^\d+$/.test(poll) || +poll < 30 || +poll > 280)
    throw Error("invalid_poll_seconds");

  const send = createHttpSender(new URL(endpoint), bearerFromFile(tokenFile));
  const read =
    deps.read ??
    (() =>
      fetchGrokUsage({
        capturedAt: new Date().toISOString(),
        credentialsPath: env.FIRE_GROK_CREDENTIALS_FILE,
      }));
  const log = deps.log ?? ((line: string) => process.stderr.write(line + "\n"));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const value = await read();
      const envelope = await captureSnapshot(value, path, alias);
      await send(envelope);
    } catch {
      log("Fire Dashboard Grok API collector: read, storage or send failed");
    }
    if (!stopped) timer = setTimeout(() => void tick(), +poll * 1000);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stop = startGrokApiService(process.env);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "Fire Dashboard Grok API collector: check FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS, FIRE_ENDPOINT, FIRE_COLLECTOR_TOKEN_FILE and FIRE_POLL_SECONDS (30-280)\n",
    );
    process.exitCode = 1;
  }
}
