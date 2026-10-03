/*
 * Long-running sender for snapshots written by short-lived collectors such as
 * the Claude statusline. It only reads local files and posts them; it never
 * talks to an AI provider.
 * FIRE_SNAPSHOT_PATHS: snapshot files, separated by the OS path delimiter.
 * FIRE_ENDPOINT: HTTPS URL of the aggregator's /api/v1/usage.
 * FIRE_COLLECTOR_TOKEN_FILE: file holding this collector's bearer token.
 * Unchanged snapshots are resent only as the sender's heartbeat.
 */
import { readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { bearerFromFile, createHttpSender } from "./sender";
import { envelopeSchema } from "../../packages/contracts/src/index";
const POLL_MS = 15000;
export function startSnapshotSender(
  env: Record<string, string | undefined>,
  deps: { log?: (line: string) => void; pollMs?: number } = {},
): () => void {
  const paths = (env.FIRE_SNAPSHOT_PATHS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  const endpoint = env.FIRE_ENDPOINT,
    tokenFile = env.FIRE_COLLECTOR_TOKEN_FILE;
  if (!paths.length || !endpoint || !tokenFile) throw Error("unconfigured");
  const url = new URL(endpoint);
  const authorization = bearerFromFile(tokenFile);
  // One sender per file: each keeps its own heartbeat state.
  const senders = paths.map((path) => ({
    path,
    send: createHttpSender(url, authorization),
  }));
  const log = deps.log ?? ((line) => process.stderr.write(line + "\n"));
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    for (const { path, send } of senders) {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (e) {
        // Nothing captured yet is normal until the collector first runs.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          log("Fire Dashboard sender: read failed");
        continue;
      }
      try {
        await send(envelopeSchema.parse(JSON.parse(raw)));
      } catch {
        // Categories only: error details may contain account data.
        log("Fire Dashboard sender: send failed");
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), deps.pollMs ?? POLL_MS);
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
    const stop = startSnapshotSender(process.env);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch {
    process.stderr.write(
      "Fire Dashboard sender: check FIRE_SNAPSHOT_PATHS, FIRE_ENDPOINT and FIRE_COLLECTOR_TOKEN_FILE\n",
    );
    process.exitCode = 1;
  }
}
