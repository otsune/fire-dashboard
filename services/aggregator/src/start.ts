import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "./server";
import { createFileStore } from "./store";
import { configSchema } from "./config";
import { startSources } from "./sources";
import type { Authorize, SourceAlias } from "./auth";
async function main() {
  const authPath = process.env.FIRE_AUTH_MODULE;
  if (!authPath) throw Error("authorization_required");
  const auth = (await import(pathToFileURL(resolve(authPath)).href)) as {
    authorize?: Authorize;
    sourceAlias?: SourceAlias;
  };
  if (
    typeof auth.authorize !== "function" ||
    typeof auth.sourceAlias !== "function"
  )
    throw Error("authorization_required");
  const origin = process.env.FIRE_PUBLIC_ORIGIN;
  if (
    !origin ||
    new URL(origin).protocol !== "https:" ||
    new URL(origin).origin !== origin
  )
    throw Error("https_origin_required");
  const configPath =
    process.env.FIRE_CONFIG ?? "services/aggregator/config.example.json";
  const config = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const store = createFileStore(
    process.env.FIRE_STATE_FILE ?? ".runtime/state.json",
  );
  const app = createServer({
    store,
    authorize: auth.authorize,
    sourceAlias: auth.sourceAlias,
    allowedOrigins: [origin],
    preferredSources: config.preferredSources,
  });
  await app.listen({ host: "127.0.0.1", port: 8787 });
  const stopSources = startSources(config, store);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    stopSources();
    await app.close();
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.stdout.write("Fire Dashboard API listening on loopback port 8787\n");
}
void main().catch(() => {
  process.stderr.write(
    "Fire Dashboard API: startup blocked; check approved auth, HTTPS origin and configuration\n",
  );
  process.exitCode = 1;
});
