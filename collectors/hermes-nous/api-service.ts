import { pathToFileURL } from "node:url";
import { captureSnapshot } from "../shared/snapshot";
import { bearerFromFile, createHttpSender } from "../shared/sender";
import type { Usage } from "../../packages/contracts/src/index";
import { fetchHermesNousUsage } from "./api";

export function startHermesNousApiService(
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

  const pythonPath = env.FIRE_HERMES_PYTHON;
  const send = createHttpSender(new URL(endpoint), bearerFromFile(tokenFile));
  const read =
    deps.read ??
    (() =>
      fetchHermesNousUsage({
        capturedAt: new Date().toISOString(),
        pythonPath,
      }));
  const log = deps.log ?? ((line) => process.stderr.write(line + "\n"));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let value: Usage;
    try {
      value = await read();
    } catch {
      log("Fire Dashboard Nous API collector: read failed");
      if (!stopped) timer = setTimeout(() => void tick(), +poll * 1000);
      return;
    }
    try {
      const envelope = await captureSnapshot(value, path, alias);
      await send(envelope);
    } catch {
      log("Fire Dashboard Nous API collector: storage or send failed");
    }
    if (!stopped) timer = setTimeout(() => void tick(), +poll * 1000);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const stop = startHermesNousApiService(process.env);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "Fire Dashboard Nous API collector: check FIRE_SNAPSHOT_PATH, FIRE_SOURCE_ALIAS (letters, digits, - or _, 1-64 chars), FIRE_ENDPOINT, FIRE_COLLECTOR_TOKEN_FILE and FIRE_POLL_SECONDS (30-280)\n",
    );
    process.exitCode = 1;
  }
}
