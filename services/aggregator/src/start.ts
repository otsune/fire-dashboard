import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer, type MqttPublisherStatus } from "./server";
import { createFileStore, type Store } from "./store";
import { configSchema, parsePort, type Config } from "./config";
import { startSources, type SourceDependencies } from "./sources";
import type { Authorize, AuthorizeAdmin, SourceAlias } from "./auth";
import { createWeatherCatalog, type WeatherCatalog } from "./weather/catalog";
import {
  initializeWeatherSettings,
  createWeatherSettings,
} from "./weather/settings";
import { readMqttCredentials } from "./mqtt/credentials";
import type { MqttPublisherOptions } from "./mqtt/publisher";

export type MqttPublisherLoadResult = {
  options?: MqttPublisherOptions;
  status: MqttPublisherStatus;
};

export async function loadMqttPublisher(
  config: Config,
): Promise<MqttPublisherLoadResult> {
  if (!config.mqtt.enabled)
    return { status: { state: "disabled" }, options: undefined };
  try {
    const credentials = await readMqttCredentials(config.mqtt.credentialsFile);
    return {
      status: { state: "ready" },
      options: {
        url: config.mqtt.url,
        topicPrefix: config.mqtt.topicPrefix,
        maxPayloadBytes: config.mqtt.maxPayloadBytes,
        username: credentials.username,
        password: credentials.password,
      },
    };
  } catch (error) {
    const code =
      error instanceof Error && /^mqtt_credentials_/.test(error.message)
        ? error.message
        : "mqtt_credentials_invalid";
    process.stderr.write(`Fire Dashboard MQTT publisher disabled: ${code}\n`);
    return { status: { state: "disabled", reason: code } };
  }
}

export async function loadMqttPublisherOptions(
  config: Config,
): Promise<MqttPublisherOptions | undefined> {
  return (await loadMqttPublisher(config)).options;
}

/** Complete local migration and source reconciliation before exposing the API. */
export async function prepareServer(options: {
  config: Config;
  store: Store;
  origin: string;
  authorize: Authorize;
  authorizeAdmin?: AuthorizeAdmin;
  sourceAlias?: SourceAlias;
  weatherCatalog?: WeatherCatalog;
  sourceDependencies?: SourceDependencies;
}) {
  await initializeWeatherSettings(options.store, options.config.weather);
  const sources = startSources(
    options.config,
    options.store,
    options.sourceDependencies,
  );
  try {
    await sources.reconcileWeather();
    const catalog = options.weatherCatalog ?? createWeatherCatalog();
    const mqtt = await loadMqttPublisher(options.config);
    const app = createServer({
      store: options.store,
      authorize: options.authorize,
      authorizeAdmin: options.authorizeAdmin,
      sourceAlias: options.sourceAlias,
      allowedOrigins: [options.origin],
      preferredSources: options.config.preferredSources,
      weatherCatalog: catalog,
      weatherSettings: createWeatherSettings({
        store: options.store,
        catalog,
        onSaved: sources.reconcileWeather,
      }),
      mqtt: mqtt.options,
      mqttStatus: mqtt.status,
      gateway: options.config.gateway.enabled
        ? {
            url: options.config.gateway.url,
            path: options.config.gateway.path,
            maxPayloadBytes: options.config.gateway.maxPayloadBytes,
            maxConnections: options.config.gateway.maxConnections,
            allowedOrigins: [options.origin],
          }
        : undefined,
    });
    return { app, sources };
  } catch (error) {
    sources.stop();
    throw error;
  }
}
async function main() {
  const authPath = process.env.FIRE_AUTH_MODULE;
  if (!authPath) throw Error("authorization_required");
  const auth = (await import(pathToFileURL(resolve(authPath)).href)) as {
    authorize?: Authorize;
    sourceAlias?: SourceAlias;
    authorizeAdmin?: AuthorizeAdmin;
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
  const port = parsePort(process.env.FIRE_PORT);
  const store = createFileStore(
    process.env.FIRE_STATE_FILE ?? ".runtime/state.json",
  );
  const { app, sources } = await prepareServer({
    config,
    store,
    authorize: auth.authorize,
    authorizeAdmin:
      typeof auth.authorizeAdmin === "function"
        ? auth.authorizeAdmin
        : undefined,
    sourceAlias: auth.sourceAlias,
    origin,
  });
  try {
    await app.listen({ host: "127.0.0.1", port });
  } catch (error) {
    sources.stop();
    await app.close();
    throw error;
  }
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    sources.stop();
    await app.close();
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.stdout.write(
    `Fire Dashboard API listening on loopback port ${port}\n`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void main().catch(() => {
    process.stderr.write(
      "Fire Dashboard API: startup blocked; check approved auth, HTTPS origin and configuration\n",
    );
    process.exitCode = 1;
  });
