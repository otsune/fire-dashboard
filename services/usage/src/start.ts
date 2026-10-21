import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  usageConfigSchema,
  resolveUsageEnvironment,
  type UsageConfig,
} from "./config";
import { createUsageServer, type MqttPublisherStatus } from "./server";
import { createFileUsageStore } from "./store";
import { readMqttCredentials } from "./mqtt/credentials";
import type { MqttPublisherOptions } from "./mqtt/publisher";
import type { Authorize, SourceAlias } from "./auth";

export async function loadUsagePublisher(
  config: UsageConfig,
): Promise<{ options?: MqttPublisherOptions; status: MqttPublisherStatus }> {
  if (!config.mqtt.enabled) return { status: { state: "disabled" } };
  try {
    const credentials = await readMqttCredentials(config.mqtt.credentialsFile);
    return {
      status: { state: "ready" },
      options: { ...config.mqtt, ...credentials },
    };
  } catch (error) {
    const reason =
      error instanceof Error && /^mqtt_credentials_/.test(error.message)
        ? error.message
        : "mqtt_credentials_invalid";
    process.stderr.write(`AI Usage MQTT publisher disabled: ${reason}\n`);
    return { status: { state: "disabled", reason } };
  }
}
export async function main() {
  const env = resolveUsageEnvironment(process.env);
  if (!env.authModule) throw Error("authorization_required");
  if (
    !env.origin ||
    new URL(env.origin).protocol !== "https:" ||
    new URL(env.origin).origin !== env.origin
  )
    throw Error("https_origin_required");
  const auth = (await import(pathToFileURL(resolve(env.authModule)).href)) as {
    authorize?: Authorize;
    sourceAlias?: SourceAlias;
  };
  if (
    typeof auth.authorize !== "function" ||
    typeof auth.sourceAlias !== "function"
  )
    throw Error("authorization_required");
  const config = usageConfigSchema.parse(
    JSON.parse(await readFile(env.configFile, "utf8")),
  );
  const store = createFileUsageStore(env.stateFile);
  // Establish a durable initial stream and fail before advertising online if
  // persistence is unavailable, including an unwritable first-run destination.
  await store.update((state) => ({ state, result: undefined }));
  const mqtt = await loadUsagePublisher(config);
  const app = createUsageServer({
    store,
    ...auth,
    authorize: auth.authorize,
    allowedOrigins: [env.origin],
    preferredSources: config.preferredSources,
    mqtt: mqtt.options,
    mqttStatus: mqtt.status,
    gateway: config.gateway.enabled
      ? { ...config.gateway, allowedOrigins: [env.origin] }
      : undefined,
  });
  try {
    await app.listen({ host: "127.0.0.1", port: env.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.stdout.write(`AI Usage API listening on loopback port ${env.port}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main().catch((error) => {
    process.stderr.write(
      `AI Usage API: startup blocked (${error instanceof Error && ["legacy_environment", "invalid_port", "authorization_required", "https_origin_required"].includes(error.message) ? error.message : "configuration_or_storage"})\n`,
    );
    process.exitCode = 1;
  });
