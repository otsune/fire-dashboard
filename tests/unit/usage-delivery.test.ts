import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emptyCommon,
  emptyDashboard,
  emptyUsage,
  usageDeliverySchema,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
import { createFileStore, createMemoryStore } from "../../services/aggregator/src/store";
import {
  createUsageIngestor,
  createUsageIngestorWithRevision,
} from "../../services/aggregator/src/usage/ingest";
import {
  applyUsageDelivery,
  shouldRefreshUsageForHeartbeat,
  usageDeliveryFromDashboard,
} from "../../apps/dashboard/src/data/usage-state";
import {
  createUsageStream,
  isUsageMqttEnabled,
} from "../../apps/dashboard/src/data/usage-stream";
import { createMqttPublisher } from "../../services/aggregator/src/mqtt/publisher";
import { createUsageServer as createServer } from "../../services/usage/src/server";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { createUsageIngestor as independentIngestor } from "../../services/usage/src/ingest";
import {
  closePendingUpstream,
  isBackpressured,
} from "../../services/aggregator/src/mqtt/gateway";
import type { UsageHeartbeat } from "../../packages/contracts/src/usage-delivery";
import type { Store, State } from "../../services/aggregator/src/store";

class FakeMqttClient {
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  publishes: Array<{
    topic: string;
    payload: string;
    options: { qos: 1; retain: boolean };
    callback?: (error?: Error) => void;
  }> = [];
  autoAckState = false;
  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: boolean },
    callback?: (error?: Error) => void,
  ) {
    this.publishes.push({ topic, payload, options, callback });
    if (!topic.endsWith("/usage/state") || this.autoAckState) callback?.();
  }
  end(_force?: boolean, _options?: Record<string, unknown>, callback?: () => void) {
    callback?.();
    return this;
  }
}

function heartbeat(
  revision: string,
  deliveryStatus: UsageHeartbeat["deliveryStatus"] = "ok",
): UsageHeartbeat {
  return {
    schemaVersion: 1,
    streamId: "stream-a",
    revision,
    instanceId: "publisher",
    sentAt: "2026-10-15T00:00:00.000Z",
    deliveryStatus,
  };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

function envelope(sequence: number, alias = "desk"): UsageEnvelope {
  return {
    snapshotId: `${alias}-${sequence}`,
    sourceAlias: alias,
    sequence,
    payload: {
      ...emptyUsage("claude"),
      ...emptyCommon("ok"),
      sourceAlias: alias,
      capturedAt: "2026-10-15T00:00:00.000Z",
      buckets: [],
    },
  };
}

it("validates decimal delivery revisions and rejects duplicate providers", () => {
  const value = {
    schemaVersion: 1 as const,
    streamId: "stream",
    revision: "1",
    publishedAt: "2026-10-15T00:00:00.000Z",
    usage: [emptyUsage("claude")],
  };
  expect(usageDeliverySchema.parse(value).revision).toBe("1");
  expect(() => usageDeliverySchema.parse({ ...value, revision: "01" })).toThrow();
  expect(() =>
    usageDeliverySchema.parse({ ...value, usage: [value.usage[0], value.usage[0]] }),
  ).toThrow();
});

it("advances persisted revision for displayed accepted and duplicate snapshots", async () => {
  const store = createMemoryStore();
  const ingest = createUsageIngestor(store, { claude: "desk" });
  expect((await store.readState()).usageRevision).toBe("0");
  await ingest(envelope(1), "2026-10-15T00:00:01.000Z", "desk");
  const first = await store.readState();
  expect(first.usageRevision).toBe("1");
  expect(first.dashboard.usageDelivery?.revision).toBe("1");
  await ingest(envelope(1), "2026-10-15T00:00:02.000Z", "desk");
  expect((await store.readState()).usageRevision).toBe("2");
  await ingest(envelope(0), "2026-10-15T00:00:03.000Z", "desk");
  expect((await store.readState()).usageRevision).toBe("2");
});

it("reports whether usage ingestion changed the published revision", async () => {
  const store = createMemoryStore();
  const ingest = createUsageIngestorWithRevision(store, { claude: "desk" });

  await expect(ingest(envelope(1), "2026-10-15T00:00:01.000Z", "desk"))
    .resolves.toEqual({ status: "accepted", revisionChanged: true });
  await expect(ingest(envelope(0), "2026-10-15T00:00:02.000Z", "desk"))
    .resolves.toEqual({ status: "older", revisionChanged: false });
});

it("does not advance revision for an accepted snapshot that stays off screen", async () => {
  const store = createMemoryStore();
  const ingest = createUsageIngestor(store, { claude: ["desk", "other"] });
  const displayed = envelope(1, "desk");
  displayed.payload.capturedAt = "2026-10-15T00:00:01.000Z";
  await ingest(displayed, "2026-10-15T00:00:01.000Z", "desk");
  const before = await store.readState();

  const offScreen = envelope(1, "other");
  offScreen.payload.capturedAt = "2026-10-15T00:00:00.500Z";
  await ingest(
    offScreen,
    "2026-10-15T00:00:00.500Z",
    "other",
  );
  const after = await store.readState();
  expect(after.usageRevision).toBe(before.usageRevision);
  expect(after.dashboard.usage.find((value) => value.provider === "claude"))
    .toMatchObject({ sourceAlias: "desk" });
});

it("does not notify MQTT when an accepted snapshot leaves the displayed revision unchanged", async () => {
  const store = createMemoryUsageStore();
  await independentIngestor(store, { claude: ["desk", "other"] })(
    envelope(1, "desk"),
    "2026-10-15T00:00:01.000Z",
    "desk",
  );
  let notifications = 0;
  const app = createServer({
    store,
    authorize: async (_request, role) => role === "collector",
    sourceAlias: async () => "other",
    preferredSources: { claude: ["desk", "other"] },
    usagePublisher: {
      start: () => undefined,
      notify: () => {
        notifications++;
      },
      stop: async () => undefined,
    },
  });
  const offScreen = envelope(1, "other");
  offScreen.payload.status = "error";
  offScreen.payload.errorCode = "network";
  await app.ready();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/usage",
    payload: offScreen,
  });
  expect(response.statusCode).toBe(200);
  expect(notifications).toBe(0);
  await app.close();
});

it("accepts only newer same-stream MQTT data and lets authenticated HTTP rotate streams", () => {
  const base = emptyDashboard();
  const first = usageDeliverySchema.parse({
    schemaVersion: 1,
    streamId: "stream-a",
    revision: "2",
    publishedAt: "2026-10-15T00:00:00.000Z",
    usage: base.usage,
  });
  const previous = applyUsageDelivery(base, first, "http").dashboard;
  const stale = applyUsageDelivery(previous, { ...first, revision: "1" }, "mqtt");
  expect(stale.accepted).toBe(false);
  const rotated = applyUsageDelivery(
    previous,
    { ...first, streamId: "stream-b", revision: "1" },
    "mqtt",
  );
  expect(rotated.reason).toBe("stream");
  const viaHttp = applyUsageDelivery(
    previous,
    { ...first, streamId: "stream-b", revision: "1" },
    "http",
  );
  expect(viaHttp.accepted).toBe(true);
  expect(usageDeliveryFromDashboard(viaHttp.dashboard)?.streamId).toBe("stream-b");
});

it("requires an explicit URL opt-in before opening the MQTT stream", () => {
  expect(isUsageMqttEnabled("")).toBe(false);
  expect(isUsageMqttEnabled("?usageMqtt=0")).toBe(false);
  expect(isUsageMqttEnabled("?screen=fire&usageMqtt=1")).toBe(true);
});

it("does not load or connect the MQTT client when the stream is disabled", () => {
  let calls = 0;
  const stream = createUsageStream({
    enabled: false,
    clientFactory: () => {
      calls++;
      throw Error("should_not_connect");
    },
  });
  stream.stop();
  expect(calls).toBe(0);
});

it("requests HTTP when a heartbeat is newer or reports an oversized delivery", () => {
  const previous = applyUsageDelivery(
    emptyDashboard(),
    usageDeliverySchema.parse({
      schemaVersion: 1,
      streamId: "stream-a",
      revision: "2",
      publishedAt: "2026-10-15T00:00:00.000Z",
      usage: emptyDashboard().usage,
    }),
    "http",
  ).dashboard;
  expect(shouldRefreshUsageForHeartbeat(previous, heartbeat("1"))).toBe(false);
  expect(shouldRefreshUsageForHeartbeat(previous, heartbeat("3"))).toBe(true);
  expect(shouldRefreshUsageForHeartbeat(previous, heartbeat("2", "too_large"))).toBe(true);
});

it("does not publish retained offline during an intentional reconnect", async () => {
  const clients: FakeMqttClient[] = [];
  const publisher = createMqttPublisher(createMemoryStore(), {
    url: "mqtt://127.0.0.1:1883",
    clientFactory: () => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("connect");
  await tick();
  clients[0].emit("error", Error("transport"));
  expect(
    clients[0].publishes.some(
      (entry) => entry.topic.endsWith("/usage/availability") && entry.payload.includes('"offline"'),
    ),
  ).toBe(false);
  await publisher.stop();
});

it("reports publisher connection and publish state without payload data", async () => {
  const store = createMemoryStore();
  await createUsageIngestor(store, { claude: "desk" })(
    envelope(1),
    "2026-10-15T00:00:01.000Z",
    "desk",
  );
  const clients: FakeMqttClient[] = [];
  const publisher = createMqttPublisher(store, {
    url: "mqtt://127.0.0.1:1883",
    heartbeatMs: 60_000,
    clientFactory: () => {
      const client = new FakeMqttClient();
      client.autoAckState = true;
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  expect(publisher.status?.()).toMatchObject({
    state: "connecting",
    connected: false,
    reconnectCount: 0,
  });
  clients[0].emit("connect");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  const status = publisher.status?.();
  expect(status).toMatchObject({
    state: "connected",
    connected: true,
    reconnectCount: 0,
    currentRevision: "1",
    lastPublishRevision: "1",
    deliveryStatus: "ok",
  });
  expect(status?.lastPublishAt).toEqual(expect.any(String));
  expect(status?.lastHeartbeatAt).toEqual(expect.any(String));
  expect(status?.lastError).toBeNull();
  expect(status?.lastErrorAt).toBeNull();
  await publisher.stop();
  expect(publisher.status?.().state).toBe("stopped");
});

it("records connection errors and replaces clients without close events", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const clients: FakeMqttClient[] = [];
  const publisher = createMqttPublisher(createMemoryStore(), {
    url: "mqtt://127.0.0.1:1883",
    clientFactory: () => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("error", new Error("connection refused"));
  expect(publisher.status?.().lastError).toBe("connect_error");
  expect(publisher.status?.().lastErrorAt).toEqual(expect.any(String));
  await vi.advanceTimersByTimeAsync(1000);
  expect(clients).toHaveLength(2);
  expect(publisher.status?.().reconnectCount).toBe(1);
  clients[1].emit("offline");
  await vi.advanceTimersByTimeAsync(2000);
  expect(clients).toHaveLength(3);
  expect(publisher.status?.().reconnectCount).toBe(2);
  await publisher.stop();
  random.mockRestore();
  vi.useRealTimers();
});

it("keeps heartbeat publishing while the usage state PUBACK is pending", async () => {
  const store = createMemoryStore();
  await createUsageIngestor(store, { claude: "desk" })(
    envelope(1),
    "2026-10-15T00:00:01.000Z",
    "desk",
  );
  expect((await store.readState()).dashboard.usageDelivery).toBeDefined();
  const saved = await store.readState();
  expect(() =>
    usageDeliverySchema.parse({
      ...saved.dashboard.usageDelivery,
      usage: saved.dashboard.usage,
    }),
  ).not.toThrow();
  const clients: FakeMqttClient[] = [];
  const publisher = createMqttPublisher(store, {
    url: "mqtt://127.0.0.1:1883",
    heartbeatMs: 60_000,
    clientFactory: () => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("connect");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const state = clients[0].publishes.find((entry) =>
    entry.topic.endsWith("/usage/state"),
  );
  const heartbeat = clients[0].publishes.find((entry) =>
    entry.topic.endsWith("/usage/heartbeat"),
  );
  expect(state?.options).toEqual({ qos: 1, retain: true });
  expect(heartbeat?.options).toEqual({ qos: 1, retain: false });
  expect(state).toBeDefined();
  expect(heartbeat).toBeDefined();
  await publisher.stop();
});

it("reconnects after a state PUBACK timeout and ignores the old callback", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  const store = createMemoryStore();
  await createUsageIngestor(store, { claude: "desk" })(
    envelope(1),
    "2026-10-15T00:00:01.000Z",
    "desk",
  );
  const clients: FakeMqttClient[] = [];
  const publisher = createMqttPublisher(store, {
    url: "mqtt://127.0.0.1:1883",
    clientFactory: () => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("connect");
  await vi.advanceTimersByTimeAsync(0);
  const first = clients[0].publishes.find((entry) =>
    entry.topic.endsWith("/usage/state"),
  );
  expect(first).toBeDefined();
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(900);
  expect(clients).toHaveLength(2);
  expect(publisher.status?.().lastError).toBe("ack_timeout");
  clients[1].emit("connect");
  await vi.advanceTimersByTimeAsync(0);
  first?.callback?.();
  expect(
    clients[1].publishes.filter((entry) => entry.topic.endsWith("/usage/state")),
  ).toHaveLength(1);
  await publisher.stop();
  random.mockRestore();
  vi.useRealTimers();
});

it("configures a retained offline LWT and publishes offline on stop", async () => {
  const clients: FakeMqttClient[] = [];
  let connectionOptions: Record<string, unknown> | undefined;
  const publisher = createMqttPublisher(createMemoryStore(), {
    url: "mqtt://127.0.0.1:1883",
    clientId: "publisher-test",
    clientFactory: (_url, options) => {
      connectionOptions = options;
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("connect");
  await publisher.stop();
  const will = connectionOptions?.will as {
    qos: number;
    retain: boolean;
    payload: string;
  };
  expect(connectionOptions?.protocolVersion).toBe(4);
  expect(connectionOptions?.clean).toBe(true);
  expect(will.qos).toBe(1);
  expect(will.retain).toBe(true);
  expect(JSON.parse(will.payload).status).toBe("offline");
  expect(
    clients[0].publishes.some(
      (entry) =>
        entry.topic.endsWith("/usage/availability") &&
        entry.payload.includes('"offline"') &&
        entry.options.retain,
    ),
  ).toBe(true);
});

it("drops an older pending state after the current state exceeds the payload limit", async () => {
  const base = await createMemoryStore().readState();
  let revision = "1";
  const smallUsage = emptyUsage("claude");
  const hugeUsage = {
    ...smallUsage,
    buckets: Array.from({ length: 32 }, (_, bucket) => ({
      id: `bucket-${bucket}`,
      label: "x".repeat(2048),
      windows: Array.from({ length: 16 }, (_, window) => ({
        id: `window-${window}`,
        label: "window",
        usedPercent: 50,
        windowMinutes: 60,
        resetsAt: "2026-10-15T00:00:00.000Z",
      })),
    })),
  };
  let usage = [smallUsage, ...base.dashboard.usage.slice(1)];
  const state = (): State => ({
    ...base,
    dashboard: {
      ...base.dashboard,
      usage,
      usageDelivery: {
        schemaVersion: 1,
        streamId: "stream-a",
        revision,
        publishedAt: "2026-10-15T00:00:00.000Z",
      },
    },
    usageRevision: revision,
    usagePublishedAt: "2026-10-15T00:00:00.000Z",
  });
  const store = { inspect: async <T>(fn: (value: State) => T) => fn(state()) } as Store;
  const clients: FakeMqttClient[] = [];
  const publisher = createMqttPublisher(store, {
    url: "mqtt://127.0.0.1:1883",
    maxPayloadBytes: 4096,
    clientFactory: () => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("connect");
  await tick();
  const first = clients[0].publishes.find((entry) => entry.topic.endsWith("/usage/state"));
  expect(first).toBeDefined();
  revision = "2";
  publisher.notify();
  await tick();
  revision = "3";
  usage = [hugeUsage, ...base.dashboard.usage.slice(1)];
  publisher.notify();
  await tick();
  first?.callback?.();
  await tick();
  expect(clients[0].publishes.filter((entry) => entry.topic.endsWith("/usage/state"))).toHaveLength(1);
  expect(publisher.status?.().deliveryStatus).toBe("too_large");
  await publisher.stop();
});

it("checks backpressure on the socket that will receive the forwarded data", () => {
  expect(isBackpressured({ bufferedAmount: 4097 }, 4096)).toBe(true);
  expect(isBackpressured({ bufferedAmount: 4096 }, 4096)).toBe(false);
});

it("closes a pending upstream when the downstream upgrade is abandoned", () => {
  let closed = false;
  closePendingUpstream({
    readyState: 1,
    close: () => {
      closed = true;
    },
  });
  expect(closed).toBe(true);
});

it("keeps a migrated stream id stable before the first write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fire-dashboard-"));
  const path = join(directory, "state.json");
  await writeFile(
    path,
    JSON.stringify({
      dashboard: emptyDashboard(),
      usageSequences: {},
      usageValues: {},
    }),
  );
  const store = createFileStore(path);
  const firstState = await store.readState();
  const secondState = await store.readState();
  expect(secondState.streamId).toBe(firstState.streamId);
  expect(firstState.dashboard.usageDelivery).toMatchObject({
    streamId: firstState.streamId,
    revision: "0",
  });
  expect(Date.parse(firstState.dashboard.usageDelivery!.publishedAt)).not.toBeNaN();
  expect(secondState.dashboard.usageDelivery).toEqual(
    firstState.dashboard.usageDelivery,
  );
});
