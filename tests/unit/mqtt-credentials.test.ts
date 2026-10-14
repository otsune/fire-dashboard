import { expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import { readMqttCredentials } from "../../services/aggregator/src/mqtt/credentials";
import { configSchema } from "../../services/aggregator/src/config";
import {
  loadMqttPublisherOptions,
  prepareServer,
} from "../../services/aggregator/src/start";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { emptyCommon, emptyUsage } from "../../packages/contracts/src/index";

it("reads MQTT credentials from an owner-only JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fire-dashboard-mqtt-"));
  const path = join(directory, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({ username: "publisher", password: "test-only" }),
    { mode: 0o600 },
  );

  await expect(readMqttCredentials(path)).resolves.toEqual({
    username: "publisher",
    password: "test-only",
  });
});

it("rejects MQTT credentials files readable by group or other users", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fire-dashboard-mqtt-"));
  const path = join(directory, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({ username: "publisher", password: "test-only" }),
    { mode: 0o600 },
  );
  await chmod(path, 0o640);

  await expect(readMqttCredentials(path)).rejects.toThrow(
    "mqtt_credentials_permissions",
  );
});

it("classifies an unreadable MQTT credentials file as a permission error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fire-dashboard-mqtt-"));
  const path = join(directory, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({ username: "publisher", password: "test-only" }),
    { mode: 0o600 },
  );
  vi.mocked(readFile).mockRejectedValueOnce(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  );

  await expect(readMqttCredentials(path)).rejects.toThrow(
    "mqtt_credentials_permissions",
  );
});

it("keeps the HTTP service available when MQTT credentials are unavailable", async () => {
  const config = configSchema.parse({
    mqtt: {
      enabled: true,
      credentialsFile: "/tmp/does-not-exist-fire-dashboard-mqtt.json",
    },
  });
  await expect(loadMqttPublisherOptions(config)).resolves.toBeUndefined();
});

it("accepts HTTP usage while the MQTT publisher is disabled by bad credentials", async () => {
  const prepared = await prepareServer({
    config: configSchema.parse({
      preferredSources: { claude: "desk" },
      mqtt: {
        enabled: true,
        credentialsFile: "/tmp/does-not-exist-fire-dashboard-mqtt.json",
      },
    }),
    store: createMemoryStore(),
    origin: "https://dashboard.example",
    authorize: async (_request, role) =>
      role === "collector" || role === "reader",
    sourceAlias: async () => "desk",
  });
  try {
    const response = await prepared.app.inject({
      method: "POST",
      url: "/api/v1/usage",
      payload: {
        snapshotId: "desk-1",
        sourceAlias: "desk",
        sequence: 1,
        payload: {
          ...emptyUsage("claude"),
          ...emptyCommon("ok"),
          sourceAlias: "desk",
          capturedAt: "2026-10-15T00:00:00.000Z",
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "accepted" });
    const status = await prepared.app.inject({
      method: "GET",
      url: "/api/v1/mqtt-status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      schemaVersion: 1,
      publisher: "disabled",
      reason: "mqtt_credentials_unavailable",
      runtime: null,
    });
  } finally {
    prepared.sources.stop();
    await prepared.app.close();
  }
});
