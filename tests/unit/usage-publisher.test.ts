import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { createMqttPublisher } from "../../services/usage/src/mqtt/publisher";
import { createUsageIngestorWithRevision } from "../../services/usage/src/ingest";
import { at, usageEnvelope } from "../helpers/usage";

it("publishes canonical retained state without Fire and recovers the latest persisted revision", async () => {
  const store = createMemoryUsageStore();
  const ingest = createUsageIngestorWithRevision(store, { claude: "desk" });
  const messages: {
    topic: string;
    payload: string;
    qos: number;
    retain: boolean;
  }[] = [];
  const client = Object.assign(new EventEmitter(), {
    publish: (
      topic: string,
      payload: string,
      opts: { qos: 1; retain: boolean },
      cb?: (error?: Error) => void,
    ) => {
      messages.push({ topic, payload, ...opts });
      cb?.();
    },
    end: (_force?: boolean, _options?: unknown, cb?: () => void) => {
      cb?.();
      return client;
    },
  });
  let will: any;
  const publisher = createMqttPublisher(store, {
    url: "mqtt://127.0.0.1:1883",
    topicPrefix: "test/v1",
    clientFactory: (_url, opts) => {
      will = opts.will;
      return client;
    },
  });
  publisher.start();
  try {
    await ingest(usageEnvelope(1), at(1), "desk");
    publisher.notify();
    await ingest(usageEnvelope(2), at(2), "desk");
    publisher.notify();
    client.emit("connect");
    await vi.waitFor(() =>
      expect(messages.some((m) => m.topic.endsWith("/state"))).toBe(true),
    );
    const states = messages.filter((m) => m.topic.endsWith("/state"));
    expect(JSON.parse(states.at(-1)!.payload)).toEqual(
      await store.readDelivery(),
    );
    expect(states.at(-1)).toMatchObject({ qos: 1, retain: true });
    expect(will).toMatchObject({ qos: 1, retain: true });
    expect(JSON.parse(will.payload).status).toBe("offline");
    expect(messages.find((m) => m.topic.endsWith("/heartbeat"))?.retain).toBe(
      false,
    );
  } finally {
    await publisher.stop();
  }
});

it("restarts after stop and never reconnects from a late callback belonging to the previous run", async () => {
  const clients: Array<
    EventEmitter & {
      publish: (...args: any[]) => void;
      end: (...args: any[]) => any;
    }
  > = [];
  const publisher = createMqttPublisher(createMemoryUsageStore(), {
    url: "mqtt://127.0.0.1:1883",
    clientFactory: () => {
      const client = Object.assign(new EventEmitter(), {
        publish: (_t: string, _p: string, _o: unknown, cb?: () => void) =>
          cb?.(),
        end: (_f?: boolean, _o?: unknown, cb?: () => void) => {
          cb?.();
          return client;
        },
      });
      clients.push(client);
      return client;
    },
  });
  publisher.start();
  clients[0].emit("connect");
  await publisher.stop();
  await publisher.stop();
  publisher.start();
  try {
    expect(clients).toHaveLength(2);
    clients[0].emit("connect");
    clients[0].emit("close");
    clients[1].emit("connect");
    await vi.waitFor(() => expect(publisher.status?.().connected).toBe(true));
  } finally {
    await publisher.stop();
  }
});

it("republishes a restored delivery stream when the next heartbeat observes its new identity", async () => {
  vi.useFakeTimers();
  const store = createMemoryUsageStore(),
    messages: any[] = [];
  const client = Object.assign(new EventEmitter(), {
    publish: (
      topic: string,
      payload: string,
      _opts: unknown,
      cb?: () => void,
    ) => {
      if (topic.endsWith("/state")) messages.push(JSON.parse(payload));
      cb?.();
    },
    end: (_force?: boolean, _opts?: unknown, cb?: () => void) => {
      cb?.();
      return client;
    },
  });
  const publisher = createMqttPublisher(store, {
    url: "mqtt://127.0.0.1:1883",
    clientFactory: () => client,
  });
  try {
    publisher.start();
    client.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    await store.update((state) => ({
      state: {
        ...state,
        delivery: { ...state.delivery, streamId: "restored", revision: "0" },
      },
      result: undefined,
    }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(messages.at(-1)).toMatchObject({
      streamId: "restored",
      revision: "0",
    });
  } finally {
    await publisher.stop();
    vi.useRealTimers();
  }
});
