import WebSocket from "ws";
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type MqttGatewayOptions = {
  url: string;
  path?: string;
  maxPayloadBytes?: number;
  maxConnections?: number;
  connectTimeoutMs?: number;
  connectionTimeoutMs?: number;
  allowedOrigins: readonly string[];
  upstreamFactory?: MqttUpstreamFactory;
};

export const DEFAULT_MQTT_GATEWAY_MAX_CONNECTIONS = 8;

/** Minimal upstream surface so gateway behavior can be exercised without a broker. */
export type MqttUpstream = {
  readyState: number;
  protocol: string;
  bufferedAmount: number;
  on: (event: string, listener: (...args: any[]) => void) => any;
  once: (event: string, listener: (...args: any[]) => void) => any;
  send: (...args: any[]) => void;
  close: (...args: any[]) => void;
  terminate: () => void;
};
export type MqttUpstreamFactory = (
  url: string,
  protocol: string,
  options: { maxPayload: number },
) => MqttUpstream;
type Upstream = MqttUpstream;
type PendingUpstream = {
  socket: Upstream;
  /** Detach request listeners after the downstream upgrade is accepted. */
  release: () => void;
};
const upstreams = new WeakMap<FastifyRequest, PendingUpstream>();
const MAX_CONNECTION_MS = 15 * 60 * 1000;

export function isBackpressured(
  target: Pick<WebSocket, "bufferedAmount">,
  maxPayload: number,
): boolean {
  return target.bufferedAmount > maxPayload;
}

export function closePendingUpstream(
  socket: { readyState: number; close: (...args: any[]) => void },
): void {
  if (socket.readyState < WebSocket.CLOSING) socket.close();
}

function protocols(request: FastifyRequest): string[] {
  const value = request.headers["sec-websocket-protocol"];
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

async function connectUpstream(
  options: MqttGatewayOptions,
  request: FastifyRequest,
  onDisposed?: () => void,
): Promise<Upstream> {
  const maxPayload = options.maxPayloadBytes ?? 2 * 1024 * 1024;
  const factory =
    options.upstreamFactory ??
    ((url, protocol, wsOptions) => new WebSocket(url, protocol, wsOptions));
  const socket = factory(options.url, "mqtt", { maxPayload });
  let disposed = false;
  const rawSocket = request.raw.socket;
  const detach = () => {
    request.raw.removeListener?.("close", dispose);
    rawSocket?.removeListener?.("close", dispose);
    rawSocket?.removeListener?.("error", dispose);
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    detach();
    const pending = upstreams.get(request);
    if (pending?.socket === socket) upstreams.delete(request);
    onDisposed?.();
    try {
      socket.terminate();
    } catch {
      try {
        closePendingUpstream(socket);
      } catch {
        /* already closed */
      }
    }
  }
  const release = () => {
    if (disposed) return;
    disposed = true;
    detach();
    const pending = upstreams.get(request);
    if (pending?.socket === socket) upstreams.delete(request);
  };
  const timeoutMs = options.connectTimeoutMs ?? 5000;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate();
      } catch {
        /* already closed */
      }
      reject(Error("upstream_timeout"));
    }, timeoutMs);
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.protocol !== "mqtt") {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        reject(Error("upstream_subprotocol"));
      } else resolve();
    });
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : Error("upstream_error"));
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Error("upstream_closed"));
    });
  }).catch((error) => {
    dispose();
    throw error;
  });
  if (disposed) {
    dispose();
    throw Error("request_closed");
  }
  upstreams.set(request, { socket, release });
  // Fastify/ws can reject the upgrade before the route websocket handler is
  // called (for example, an invalid Sec-WebSocket-Version). In that case the
  // IncomingMessage's close event is not reliable, but the raw TCP socket is.
  // Attach these listeners only after the upstream is ready: injectWS uses a
  // synthetic request whose transport may already be closed by this point.
  request.raw.once?.("close", dispose);
  rawSocket?.once?.("close", dispose);
  rawSocket?.once?.("error", dispose);
  if (rawSocket?.destroyed) {
    dispose();
    throw Error("request_closed");
  }
  return socket;
}

/** Registers the authenticated reader-to-Mosquitto WebSocket bridge. */
export function registerMqttGateway(
  app: FastifyInstance,
  options: MqttGatewayOptions,
): void {
  const maxPayload = options.maxPayloadBytes ?? 2 * 1024 * 1024;
  const path = options.path ?? "/api/v1/usage/stream";
  const connectionTimeoutMs = options.connectionTimeoutMs ?? MAX_CONNECTION_MS;
  const maxConnections = Math.max(
    1,
    Math.floor(options.maxConnections ?? DEFAULT_MQTT_GATEWAY_MAX_CONNECTIONS),
  );
  let connectionCount = 0;
  const reservations = new WeakMap<FastifyRequest, () => void>();
  const reserveConnection = (request: FastifyRequest): (() => void) | null => {
    if (connectionCount >= maxConnections) return null;
    connectionCount++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      connectionCount--;
      if (reservations.get(request) === release) reservations.delete(request);
    };
    reservations.set(request, release);
    return release;
  };
  app.register(websocket, {
    options: {
      maxPayload,
      handleProtocols: (requested) =>
        requested.has("mqtt") ? "mqtt" : false,
    },
  });
  app.after(() => {
    app.get(
      path,
      {
        websocket: true,
        preHandler: async (request, reply) => {
          const origin = request.headers.origin;
          if (!origin || !options.allowedOrigins.includes(origin)) {
            await reply.code(403).send({ error: "origin_denied" });
            return;
          }
          if (!protocols(request).includes("mqtt")) {
            await reply.code(400).send({ error: "subprotocol_required" });
            return;
          }
          const releaseConnection = reserveConnection(request);
          if (!releaseConnection) {
            await reply
              .code(503)
              .header("retry-after", "5")
              .send({ error: "connection_limit" });
            return;
          }
          try {
            await connectUpstream(options, request, releaseConnection);
          } catch {
            releaseConnection();
            await reply.code(503).send({ error: "upstream_unavailable" });
          }
        },
      },
      (socket, request) => {
        const pending = upstreams.get(request);
        const releaseConnection = reservations.get(request) ?? (() => undefined);
        pending?.release();
        const upstream = pending?.socket;
        if (!upstream) {
          releaseConnection();
          try {
            socket.close(1011, "upstream_unavailable");
          } catch {
            /* already closed */
          }
          return;
        }
        let lifetime: ReturnType<typeof setTimeout> | undefined;
        const closeBoth = () => {
          releaseConnection();
          if (lifetime) clearTimeout(lifetime);
          try {
            if (upstream.readyState < WebSocket.CLOSING) upstream.close();
          } catch {
            /* already closed */
          }
          try {
            if (socket.readyState < WebSocket.CLOSING) socket.close();
          } catch {
            /* already closed */
          }
        };
        lifetime = setTimeout(closeBoth, connectionTimeoutMs);
        socket.on("message", (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN) return closeBoth();
          if (isBackpressured(upstream, maxPayload)) return closeBoth();
          upstream.send(data, { binary: isBinary });
        });
        upstream.on("message", (data, isBinary) => {
          if (socket.readyState !== WebSocket.OPEN) return closeBoth();
          if (isBackpressured(socket, maxPayload)) return closeBoth();
          socket.send(data, { binary: isBinary });
        });
        socket.on("close", closeBoth);
        socket.on("error", closeBoth);
        upstream.on("close", closeBoth);
        upstream.on("error", closeBoth);
      },
    );
  });
}
