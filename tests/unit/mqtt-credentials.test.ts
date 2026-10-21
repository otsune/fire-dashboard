import { expect, it, vi } from "vitest";
import { chmod, mkdtemp, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { readMqttCredentials } from "../../services/usage/src/mqtt/credentials";
import { usageConfigSchema as configSchema } from "../../services/usage/src/config";
import { loadUsagePublisher } from "../../services/usage/src/start";
import { createUsageServer } from "../../services/usage/src/server";
import { createMemoryUsageStore } from "../../services/usage/src/store";
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
  vi.mocked(open).mockRejectedValueOnce(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  );

  await expect(readMqttCredentials(path)).rejects.toThrow(
    "mqtt_credentials_permissions",
  );
});

it("rejects symlinked credentials instead of checking and reading different file identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mqtt-symlink-"));
  const path = join(dir, "secret.json"),
    alias = join(dir, "alias.json");
  await writeFile(
    path,
    JSON.stringify({ username: "test", password: "test-only" }),
    { mode: 0o600 },
  );
  await symlink(path, alias);
  await expect(readMqttCredentials(alias)).rejects.toThrow(
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
  await expect(loadUsagePublisher(config)).resolves.toMatchObject({
    status: { state: "disabled" },
  });
});

it("accepts HTTP usage while the MQTT publisher is disabled by bad credentials", async () => {
  const config = configSchema.parse({
    preferredSources: { claude: "desk" },
    mqtt: {
      enabled: true,
      credentialsFile: "/tmp/does-not-exist-fire-dashboard-mqtt.json",
    },
  });
  const mqtt = await loadUsagePublisher(config);
  const app = createUsageServer({
    store: createMemoryUsageStore(),
    authorize: async () => true,
    sourceAlias: async () => "desk",
    preferredSources: config.preferredSources,
    mqtt: mqtt.options,
    mqttStatus: mqtt.status,
  });
  try {
    const response = await app.inject({
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
    const status = await app.inject({
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
    await app.close();
  }
});
