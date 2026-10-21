import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import mqtt, { type MqttClient } from "mqtt";
import { createUsageServer } from "../../services/usage/src/server";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { createServer } from "../../services/aggregator/src/server";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { usageEnvelope } from "../helpers/usage";

// Opt-in: requires an existing local image and permission to run rootless Podman.
it.skipIf(process.env.USAGE_BROKER_TEST !== "1")(
  "delivers usage without Fire, recovers after broker restart and enforces reader ACL over TCP and the Fire WSS relay",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-broker-"));
    const name = `usage-test-${randomUUID()}`;
    const image = "docker.io/library/eclipse-mosquitto:2";
    const prefix = `test-${randomUUID()}/v1`;
    const clients: MqttClient[] = [];
    const podman = (...args: string[]) =>
      execFileSync("rtk", ["proxy", "podman", ...args], {
        encoding: "utf8",
        timeout: 30000,
      });
    let backend: ReturnType<typeof createUsageServer> | undefined;
    let fire: ReturnType<typeof createServer> | undefined;
    let containerStarted = false;
    const origin = "https://display.example";
    async function connect(url: string, options: mqtt.IClientOptions = {}) {
      const client = mqtt.connect(url, {
        protocolVersion: 4,
        reconnectPeriod: 0,
        connectTimeout: 5000,
        ...options,
      });
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", () => resolve());
        client.once("error", reject);
      });
      return client;
    }
    async function retained(client: MqttClient) {
      const received = new Promise<{ revision: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("state_timeout")), 10000);
        client.once("message", (_topic, payload, packet) => {
          clearTimeout(timer);
          try {
            expect(packet.retain).toBe(true);
            resolve(JSON.parse(payload.toString()));
          } catch (e) {
            reject(e);
          }
        });
      });
      await client.subscribeAsync(`${prefix}/usage/state`, { qos: 1 });
      return received;
    }
    try {
      await chmod(dir, 0o755);
      for (const [index, user] of ["publisher", "reader"].entries())
        podman(
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--user=0",
          "-v",
          `${dir}:/work`,
          image,
          "mosquitto_passwd",
          ...(index === 0 ? ["-c"] : []),
          "-b",
          "/work/passwords",
          user,
          "test-only",
        );
      await chmod(join(dir, "passwords"), 0o644);
      await writeFile(
        join(dir, "acl"),
        `user publisher\ntopic write ${prefix}/usage/#\nuser reader\ntopic read ${prefix}/usage/#\n`,
      );
      await writeFile(join(dir, "ws-acl"), `topic read ${prefix}/usage/#\n`);
      await writeFile(
        join(dir, "mosquitto.conf"),
        "per_listener_settings true\nlistener 1883 0.0.0.0\nallow_anonymous false\npassword_file /mosquitto/config/passwords\nacl_file /mosquitto/config/acl\nlistener 9001 0.0.0.0\nprotocol websockets\nallow_anonymous true\nacl_file /mosquitto/config/ws-acl\npersistence false\n",
      );
      podman(
        "run",
        "-d",
        "--pull=never",
        "--name",
        name,
        "--user=0",
        "-p",
        "127.0.0.1::1883",
        "-p",
        "127.0.0.1::9001",
        "-v",
        `${dir}:/mosquitto/config:ro`,
        image,
      );
      containerStarted = true;
      const port = (n: number) =>
        Number(podman("port", name, `${n}/tcp`).trim().split(":").at(-1));
      const tcp = `mqtt://127.0.0.1:${port(1883)}`;
      const ws = `ws://127.0.0.1:${port(9001)}/mqtt`;
      backend = createUsageServer({
        store: createMemoryUsageStore(),
        authorize: async (req, role) =>
          req.headers.authorization === `Bearer ${role}`,
        sourceAlias: async () => "desk",
        preferredSources: { claude: "desk" },
        allowedOrigins: [origin],
        mqtt: {
          url: tcp,
          username: "publisher",
          password: "test-only",
          topicPrefix: prefix,
        },
        gateway: { url: ws, allowedOrigins: [origin] },
      });
      expect(
        (
          await backend.inject({
            method: "POST",
            url: "/api/v1/usage",
            headers: { authorization: "Bearer collector" },
            payload: usageEnvelope(1),
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(
        async () => {
          const s = (
            await backend!.inject({
              url: "/api/v1/mqtt-status",
              headers: { authorization: "Bearer reader" },
            })
          ).json();
          expect(s.runtime.lastPublishRevision).toBe("1");
        },
        { timeout: 10000 },
      );
      const reader = await connect(tcp, {
        username: "reader",
        password: "test-only",
      });
      expect((await retained(reader)).revision).toBe("1");
      // MQTT 3.1.1 may acknowledge a denied publish. Verify the retained state is unchanged.
      await reader.publishAsync(
        `${prefix}/usage/state`,
        JSON.stringify({ revision: "forged" }),
        { qos: 1, retain: true },
      );
      const check = await connect(tcp, {
        username: "reader",
        password: "test-only",
      });
      expect((await retained(check)).revision).toBe("1");
      podman("restart", name);
      expect(
        (
          await backend.inject({
            method: "POST",
            url: "/api/v1/usage",
            headers: { authorization: "Bearer collector" },
            payload: usageEnvelope(2),
          })
        ).statusCode,
      ).toBe(200);
      await vi.waitFor(
        async () => {
          const s = (
            await backend!.inject({
              url: "/api/v1/mqtt-status",
              headers: { authorization: "Bearer reader" },
            })
          ).json();
          expect(s.runtime.lastPublishRevision).toBe("2");
        },
        { timeout: 15000 },
      );
      const restored = await connect(tcp, {
        username: "reader",
        password: "test-only",
      });
      expect((await retained(restored)).revision).toBe("2");
      // Only now create Fire. Its bridge is a consumer of the independent API.
      const backendAddress = await backend.listen({
        host: "127.0.0.1",
        port: 0,
      });
      fire = createServer({
        store: createMemoryStore(),
        authorize: async (req, role) =>
          role === "reader" && req.headers["x-test-reader"] === "yes",
        allowedOrigins: [origin],
        usageRelay: { baseUrl: backendAddress, readerToken: "reader", origin },
      });
      const address = await fire.listen({ host: "127.0.0.1", port: 0 });
      const display = await connect(
        address.replace("http:", "ws:") + "/api/v1/usage/stream",
        {
          wsOptions: {
            headers: {
              origin,
              "x-test-reader": "yes",
              "tailscale-user-login": "forged",
            },
          },
        },
      );
      expect((await retained(display)).revision).toBe("2");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("reader_publish_not_closed")),
          5000,
        );
        display.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        display.publish(
          `${prefix}/usage/state`,
          JSON.stringify({ revision: "forged-wss" }),
          { qos: 1, retain: true },
        );
      });
      const finalCheck = await connect(tcp, {
        username: "reader",
        password: "test-only",
      });
      expect((await retained(finalCheck)).revision).toBe("2");
    } finally {
      for (const client of clients) client.end(true);
      await fire?.close();
      await backend?.close();
      if (containerStarted) podman("rm", "-f", name);
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
