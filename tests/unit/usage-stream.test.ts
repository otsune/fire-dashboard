/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createUsageStream } from "../../apps/dashboard/src/data/usage-stream";

class FakeClient {
  connected = false;
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  subscriptions: string[] = [];
  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  subscribe(topics: string[]) {
    this.subscriptions.push(...topics);
  }
  end() {}
}

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
