import { once } from "node:events";
import net from "node:net";
import { expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "../../services/aggregator/src/server";
import { createMemoryStore } from "../../services/aggregator/src/store";
import type {
  MqttUpstream,
  MqttUpstreamFactory,
} from "../../services/usage/src/mqtt/gateway";

class FakeUpstream implements MqttUpstream {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  protocol = "mqtt";
  sent: Array<{ data: WebSocket.Data; binary: boolean }> = [];
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  onceListeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void) {
    this.onceListeners.set(event, [
      ...(this.onceListeners.get(event) ?? []),
      listener,
    ]);
    return this;
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
    const once = this.onceListeners.get(event) ?? [];
    this.onceListeners.delete(event);
    for (const listener of once) listener(...args);
  }

  send(data: WebSocket.Data, options?: { binary?: boolean }) {
    this.sent.push({ data, binary: options?.binary ?? false });
  }

  close() {
    this.readyState = WebSocket.CLOSING;
    this.emit("close");
  }

  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function upstreamFactory(
  upstream: FakeUpstream,
  protocol = "mqtt",
): MqttUpstreamFactory {
  upstream.protocol = protocol;
  return (_url, _requestedProtocol, _options) => {
    queueMicrotask(() => upstream.emit("open"));
    return upstream;
  };
}

it("bridges an authenticated mqtt websocket to the loopback upstream", async () => {
  const upstream = new FakeUpstream();
  let requestedProtocol = "";
  const app = createServer({
    store: createMemoryStore(),
    authorize: async (request, role) =>
      role === "reader" && request.headers["x-test-role"] === "reader",
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: "ws://127.0.0.1:9001/mqtt",
      allowedOrigins: ["https://dashboard.example"],
      maxPayloadBytes: 1024,
      upstreamFactory: (url, protocol, options) => {
        requestedProtocol = protocol;
        expect(url).toBe("ws://127.0.0.1:9001/mqtt");
        expect(options.maxPayload).toBe(1024);
        return upstreamFactory(upstream)(url, protocol, options);
      },
    },
  });
  await app.ready();
  const socket = await app.injectWS("/api/v1/usage/stream", {
    headers: {
      origin: "https://dashboard.example",
      "x-test-role": "reader",
      "sec-websocket-protocol": "mqtt",
    },
  });
  expect(requestedProtocol).toBe("mqtt");
  const received = new Promise<string>((resolve) =>
    socket.once("message", (message) => resolve(message.toString())),
  );
  socket.send("usage");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(upstream.sent[0]?.data.toString()).toBe("usage");
  upstream.emit("message", Buffer.from("reply"), false);
  expect(await received).toBe("reply");
  socket.terminate();
  await app.close();
});

it("rejects connections over the limit and releases the slot after close", async () => {
  const upstreams: FakeUpstream[] = [];
  const app = createServer({
    store: createMemoryStore(),
    authorize: async (_request, role) => role === "reader",
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: "ws://127.0.0.1:9001/mqtt",
      allowedOrigins: ["https://dashboard.example"],
      maxConnections: 1,
      upstreamFactory: (_url, _protocol, _options) => {
        const upstream = new FakeUpstream();
        upstreams.push(upstream);
        queueMicrotask(() => upstream.emit("open"));
        return upstream;
      },
    },
  });
  await app.ready();
  const headers = {
    origin: "https://dashboard.example",
    "sec-websocket-protocol": "mqtt",
  };
  const first = await app.injectWS("/api/v1/usage/stream", { headers });
  await expect(
    app.injectWS("/api/v1/usage/stream", { headers }),
  ).rejects.toThrow("Unexpected server response: 503");

  const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
  first.terminate();
  await closed;

  const third = await app.injectWS("/api/v1/usage/stream", { headers });
  expect(upstreams).toHaveLength(2);
  third.terminate();
  await app.close();
});

it("rejects a websocket without the dashboard origin or mqtt protocol", async () => {
  const upstream = new FakeUpstream();
  const app = createServer({
    store: createMemoryStore(),
    authorize: async (_request, role) => role === "reader",
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: "ws://127.0.0.1:9001/mqtt",
      allowedOrigins: ["https://dashboard.example"],
      upstreamFactory: upstreamFactory(upstream),
    },
  });
  await app.ready();
  await expect(
    app.injectWS("/api/v1/usage/stream", {
      headers: {
        "x-test-role": "reader",
        "sec-websocket-protocol": "mqtt",
      },
    }),
  ).rejects.toThrow("Unexpected server response: 403");
  await expect(
    app.injectWS("/api/v1/usage/stream", {
      headers: {
        origin: "https://dashboard.example",
        "x-test-role": "reader",
      },
    }),
  ).rejects.toThrow("Unexpected server response: 400");
  await app.close();
});

it("does not authenticate a collector as a websocket reader", async () => {
  const upstream = new FakeUpstream();
  const app = createServer({
    store: createMemoryStore(),
    authorize: async (request, role) => request.headers["x-test-role"] === role,
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: "ws://127.0.0.1:9001/mqtt",
      allowedOrigins: ["https://dashboard.example"],
      upstreamFactory: upstreamFactory(upstream),
    },
  });
  await app.ready();
  await expect(
    app.injectWS("/api/v1/usage/stream", {
      headers: {
        origin: "https://dashboard.example",
        "x-test-role": "collector",
        "sec-websocket-protocol": "mqtt",
      },
    }),
  ).rejects.toThrow("Unexpected server response: 403");
  await app.close();
});

it("does not return 101 when the upstream rejects the mqtt subprotocol", async () => {
  const upstream = new FakeUpstream();
  const app = createServer({
    store: createMemoryStore(),
    authorize: async (_request, role) => role === "reader",
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: "ws://127.0.0.1:9001/mqtt",
      allowedOrigins: ["https://dashboard.example"],
      upstreamFactory: upstreamFactory(upstream, ""),
    },
  });
  await app.ready();
  await expect(
    app.injectWS("/api/v1/usage/stream", {
      headers: {
        origin: "https://dashboard.example",
        "x-test-role": "reader",
        "sec-websocket-protocol": "mqtt",
      },
    }),
  ).rejects.toThrow("Unexpected server response: 503");
  expect(upstream.readyState).toBe(WebSocket.CLOSED);
  await app.close();
});

it("closes both sockets at the configured connection lifetime", async () => {
  const upstream = new FakeUpstream();
  const app = createServer({
    store: createMemoryStore(),
    authorize: async (_request, role) => role === "reader",
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: "ws://127.0.0.1:9001/mqtt",
      allowedOrigins: ["https://dashboard.example"],
      upstreamFactory: upstreamFactory(upstream),
      connectionTimeoutMs: 10,
    },
  });
  await app.ready();
  const socket = await app.injectWS("/api/v1/usage/stream", {
    headers: {
      origin: "https://dashboard.example",
      "x-test-role": "reader",
      "sec-websocket-protocol": "mqtt",
    },
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await expect(
    Promise.race([
      closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 100)),
    ]),
  ).resolves.toBe("closed");
  expect(upstream.readyState).toBe(WebSocket.CLOSING);
  await app.close();
});

it("closes an upstream when ws rejects the downstream upgrade", async () => {
  const upstreamServer = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (requested) =>
      requested.has("mqtt") ? "mqtt" : false,
  });
  await once(upstreamServer, "listening");
  const upstreamAddress = upstreamServer.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw Error("upstream_listen_failed");

  let upstreamOpened!: () => void;
  let upstreamClosed!: () => void;
  const opened = new Promise<void>((resolve) => {
    upstreamOpened = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  upstreamServer.once("connection", (socket) => {
    upstreamOpened();
    socket.once("close", upstreamClosed);
  });

  const app = createServer({
    store: createMemoryStore(),
    authorize: async (request, role) =>
      role === "reader" && request.headers["x-test-role"] === "reader",
    allowedOrigins: ["https://dashboard.example"],
    gateway: {
      url: `ws://127.0.0.1:${upstreamAddress.port}/mqtt`,
      allowedOrigins: ["https://dashboard.example"],
    },
  });

  let client: net.Socket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("listen_failed");
    client = net.connect(address.port, "127.0.0.1", () => {
      client?.write(
        [
          "GET /api/v1/usage/stream HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Origin: https://dashboard.example",
          "X-Test-Role: reader",
          "Sec-WebSocket-Version: 12",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: mqtt",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const response = new Promise<string>((resolve) => {
      let value = "";
      client!.on("data", (chunk) => {
        value += chunk.toString();
        if (value.includes("\r\n\r\n")) resolve(value);
      });
    });
    client.on("error", () => undefined);
    const rawResponse = await Promise.race([
      response,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(Error("downstream_response_timeout")), 2000),
      ),
    ]);
    expect(rawResponse).toMatch(/^HTTP\/1\.1 400\b/m);
    await opened;
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Error("upstream_cleanup_timeout")), 2000),
      ),
    ]);
  } finally {
    client?.destroy();
    await app.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});

