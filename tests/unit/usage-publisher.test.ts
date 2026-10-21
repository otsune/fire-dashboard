import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { createMqttPublisher } from "../../services/usage/src/mqtt/publisher";
import { createUsageIngestorWithRevision } from "../../services/usage/src/ingest";
import { at, usageEnvelope } from "../helpers/usage";

it("publishes canonical retained state without Fire and recovers the latest persisted revision", async () => {
  const store = createMemoryUsageStore();
  const ingest = createUsageIngestorWithRevision(store, { claude: "desk" });
  const messages: { topic: string; payload: string; qos: number; retain: boolean }[] = [];
  const client = Object.assign(new EventEmitter(), {
    publish: (topic: string, payload: string, opts: { qos: 1; retain: boolean }, cb?: (error?: Error) => void) => { messages.push({ topic, payload, ...opts }); cb?.(); },
    end: (_force?: boolean, _options?: unknown, cb?: () => void) => { cb?.(); return client; },
  });
  let will: any;
  const publisher = createMqttPublisher(store, { url: "mqtt://127.0.0.1:1883", topicPrefix: "test/v1", clientFactory: (_url, opts) => { will = opts.will; return client; } });
  publisher.start();
  try {
    await ingest(usageEnvelope(1), at(1), "desk"); publisher.notify();
    await ingest(usageEnvelope(2), at(2), "desk"); publisher.notify();
    client.emit("connect");
    await vi.waitFor(() => expect(messages.some(m => m.topic.endsWith("/state"))).toBe(true));
    const states = messages.filter(m => m.topic.endsWith("/state"));
    expect(JSON.parse(states.at(-1)!.payload)).toEqual(await store.readDelivery());
    expect(states.at(-1)).toMatchObject({ qos: 1, retain: true });
    expect(will).toMatchObject({ qos: 1, retain: true });
    expect(JSON.parse(will.payload).status).toBe("offline");
    expect(messages.find(m => m.topic.endsWith("/heartbeat"))?.retain).toBe(false);
  } finally { await publisher.stop(); }
});
