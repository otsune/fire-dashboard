/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createUsageStream } from "../../apps/dashboard/src/data/usage-stream";

class FakeClient {
  connected = false;
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  subscriptions: string[] = [];
  ended = false;
  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  subscribe(topics: string[]) {
    this.subscriptions.push(...topics);
  }
  end() {
    this.ended = true;
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("reconciles a client that connected before listeners were attached", async () => {
  const client = new FakeClient();
  client.connected = true;
  const events: string[] = [];
  let timerVariant: unknown;
  const stream = createUsageStream({
    enabled: true,
    clientFactory: (_url, options) => {
      timerVariant = options.timerVariant;
      return client;
    },
    onStatus: (status) => events.push(status),
  });
  await tick();
  expect(events).toEqual(["connecting", "connected"]);
  expect(timerVariant).toBe("native");
  expect(client.subscriptions).toHaveLength(3);
  stream.stop();
});

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

it("subscribes to the three usage topics and validates heartbeat messages", async () => {
  const client = new FakeClient();
  const heartbeats: unknown[] = [];
  const stream = createUsageStream({
    enabled: true,
    topicPrefix: "fire-dashboard/test",
    clientFactory: () => client,
    onHeartbeat: (value) => heartbeats.push(value),
  });
  await tick();
  client.emit("connect");
  expect(client.subscriptions).toEqual([
    "fire-dashboard/test/usage/state",
    "fire-dashboard/test/usage/availability",
    "fire-dashboard/test/usage/heartbeat",
  ]);
  client.emit(
    "message",
    "fire-dashboard/test/usage/heartbeat",
    JSON.stringify({
      schemaVersion: 1,
      streamId: "stream",
      revision: "1",
      instanceId: "publisher",
      sentAt: "2026-10-15T00:00:00.000Z",
      deliveryStatus: "ok",
    }),
  );
  expect(heartbeats).toHaveLength(1);
  stream.stop();
});

it("emits connected before the heartbeat callback can report an error", async () => {
  const client = new FakeClient();
  const events: string[] = [];
  const stream = createUsageStream({
    enabled: true,
    clientFactory: () => client,
    onStatus: (status) => events.push(`status:${status}`),
    onHeartbeat: () => events.push("heartbeat"),
  });
  await tick();
  client.emit("connect");
  events.length = 0;
  client.emit(
    "message",
    "fire-dashboard/v1/main/usage/heartbeat",
    JSON.stringify({
      schemaVersion: 1,
      streamId: "stream",
      revision: "1",
      instanceId: "publisher",
      sentAt: "2026-10-15T00:00:00.000Z",
      deliveryStatus: "ok",
    }),
  );
  expect(events).toEqual(["status:connected", "heartbeat"]);
  stream.stop();
});

it("keeps a healthy connection on resume, backs off after close, and releases timers on stop", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const clients: FakeClient[] = [];
  const statuses: string[] = [];
  const stream = createUsageStream({
    enabled: true,
    onStatus: (s) => statuses.push(s),
    clientFactory: () => {
      const c = new FakeClient();
      c.connected = true;
      clients.push(c);
      return c;
    },
  });
  await tick();
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(clients).toHaveLength(1);
  clients[0].connected = false;
  clients[0].emit("close");
  await vi.advanceTimersByTimeAsync(999);
  expect(clients).toHaveLength(1);
  window.dispatchEvent(new Event("online"));
  await tick();
  expect(clients).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(clients).toHaveLength(2);
  stream.stop();
  stream.stop();
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(300000);
  expect(clients).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports malformed and oversized state without discarding the last valid delivery", async () => {
  const client = new FakeClient(),
    deliveries: unknown[] = [],
    statuses: string[] = [];
  const stream = createUsageStream({
    enabled: true,
    maxPayloadBytes: 128,
    clientFactory: () => client,
    onDelivery: (v) => deliveries.push(v),
    onStatus: (s) => statuses.push(s),
  });
  await tick();
  client.emit("connect");
  client.emit("message", "fire-dashboard/v1/main/usage/state", "{broken");
  expect(statuses.at(-1)).toBe("error");
  client.emit(
    "message",
    "fire-dashboard/v1/main/usage/state",
    new Uint8Array(129),
  );
  expect(deliveries).toHaveLength(0);
  expect(statuses.at(-1)).toBe("error");
  stream.stop();
});

it("disposes an obsolete async client factory result after forced reconnect or stop", async () => {
  const pending: Array<(client: FakeClient) => void> = [];
  const stream = createUsageStream({
    enabled: true,
    clientFactory: () => new Promise((resolve) => pending.push(resolve)),
  });
  await tick();
  stream.reconnect();
  await tick();
  expect(pending).toHaveLength(2);
  const old = new FakeClient();
  old.connected = true;
  pending[0](old);
  await tick();
  expect(old.ended).toBe(true);
  expect(old.subscriptions).toHaveLength(0);
  stream.stop();
  const late = new FakeClient();
  pending[1](late);
  await tick();
  expect(late.ended).toBe(true);
});
