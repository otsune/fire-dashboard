import {
  usageAvailabilitySchema,
  usageDeliverySchema,
  usageHeartbeatSchema,
  type UsageDelivery,
} from "../../../../packages/contracts/src/index";
import type { IClientOptions } from "mqtt";

export type UsageStreamStatus =
  "disconnected" | "connecting" | "connected" | "stale" | "error" | "syncing";
export type UsageStreamOptions = {
  enabled?: boolean;
  url?: string;
  topicPrefix?: string;
  maxPayloadBytes?: number;
  onStatus?: (status: UsageStreamStatus) => void;
  onDelivery?: (value: UsageDelivery) => void;
  onHeartbeat?: (value: ReturnType<typeof usageHeartbeatSchema.parse>) => void;
  onAvailability?: (
    value: ReturnType<typeof usageAvailabilitySchema.parse>,
  ) => void;
  onTooLarge?: () => void;
  clientFactory?: UsageMqttClientFactory;
};
export type UsageStream = { stop: () => void; reconnect: () => void };
export type UsageMqttClient = {
  connected?: boolean;
  on: (event: string, listener: (...args: any[]) => void) => void;
  subscribe: (topics: string[], options: { qos: 1 }) => void;
  end: (force?: boolean) => void;
};
export type UsageMqttClientFactory = (
  url: string,
  options: IClientOptions,
) => UsageMqttClient | Promise<UsageMqttClient>;

export function isUsageMqttEnabled(search = "") {
  return new URLSearchParams(search).get("usageMqtt") === "1";
}

function defaultUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/v1/usage/stream`;
}

function decode(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  if (
    payload &&
    typeof (payload as { toString?: () => string }).toString === "function"
  )
    return (payload as { toString: () => string }).toString();
  throw Error("invalid_payload");
}

export function createUsageStream(
  options: UsageStreamOptions = {},
): UsageStream {
  if (options.enabled === false) return { reconnect: () => {}, stop: () => {} };
  const prefix = (options.topicPrefix ?? "fire-dashboard/v1/main").replace(
    /\/+$/,
    "",
  );
  const topics = {
    state: `${prefix}/usage/state`,
    availability: `${prefix}/usage/availability`,
    heartbeat: `${prefix}/usage/heartbeat`,
  };
  const maxBytes = options.maxPayloadBytes ?? 2 * 1024 * 1024;
  let stopped = false;
  let client: UsageMqttClient | null = null;
  let connecting = false;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatWatch: ReturnType<typeof setInterval> | undefined;
  let lastHeartbeat = 0;
  let retry = 0;
  const emit = (status: UsageStreamStatus) => options.onStatus?.(status);
  const schedule = () => {
    if (stopped || retryTimer) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(retry++, 6));
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        connect();
      },
      Math.round(delay * (0.9 + Math.random() * 0.2)),
    );
  };
  const connect = () => {
    if (stopped || client || connecting) return;
    connecting = true;
    const run = ++generation;
    emit("connecting");
    const clientOptions: IClientOptions = {
      protocolVersion: 4,
      clean: true,
      clientId: `fire-dashboard-${crypto.randomUUID()}`,
      reconnectPeriod: 0,
      // The dashboard CSP intentionally disallows blob workers. MQTT.js's
      // default `auto` timer selects worker-timers in browsers, which would
      // fail after CONNACK and leave the UI stuck in `connecting`.
      timerVariant: "native",
    };
    const createClient = options.clientFactory
      ? () => options.clientFactory!(options.url ?? defaultUrl(), clientOptions)
      : async () =>
          (await import("mqtt")).default.connect(
            options.url ?? defaultUrl(),
            clientOptions,
          ) as unknown as UsageMqttClient;
    void Promise.resolve()
      .then(createClient)
      .then((next) => {
        if (stopped || run !== generation) {
          next.end(true);
          return;
        }
        client = next;
        let announcedConnected = false;
        const announceConnected = () => {
          if (announcedConnected || next !== client) return;
          announcedConnected = true;
          connecting = false;
          retry = 0;
          lastHeartbeat = Date.now();
          emit("connected");
          next.subscribe(Object.values(topics), { qos: 1 });
        };
        next.on("connect", announceConnected);
        next.on("message", (topic: string, raw: unknown) => {
          if (
            next !== client ||
            stopped ||
            !Object.values(topics).includes(topic)
          )
            return;
          try {
            // Bound bytes before materializing the text; keep the decoding pass
            // as the authoritative check for string payloads.
            if (raw instanceof Uint8Array && raw.byteLength > maxBytes)
              throw Error("too_large");
            const text = decode(raw);
            if (new TextEncoder().encode(text).byteLength > maxBytes)
              throw Error("too_large");
            const parsed = JSON.parse(text);
            if (topic === topics.state) {
              const delivery = usageDeliverySchema.parse(parsed);
              options.onDelivery?.(delivery);
            } else if (topic === topics.heartbeat) {
              const heartbeat = usageHeartbeatSchema.parse(parsed);
              lastHeartbeat = Date.now();
              if (heartbeat.deliveryStatus !== "too_large") emit("connected");
              options.onHeartbeat?.(heartbeat);
              if (heartbeat.deliveryStatus === "too_large")
                options.onTooLarge?.();
            } else
              options.onAvailability?.(usageAvailabilitySchema.parse(parsed));
          } catch {
            emit("error");
            // Keep the last valid value for malformed or oversized data.
          }
        });
        next.on("close", () => {
          if (next !== client) return;
          client = null;
          connecting = false;
          emit("disconnected");
          schedule();
        });
        next.on("error", () => {
          if (next === client) emit("error");
        });
        // A very fast WebSocket handshake can emit MQTT's `connect` event
        // before the promise continuation above attaches the listener. The
        // mqtt.js client keeps the authoritative flag, so reconcile it here.
        if (next.connected) announceConnected();
      })
      .catch(() => {
        if (stopped || run !== generation) return;
        connecting = false;
        emit("error");
        schedule();
      });
  };
  const reconnect = () => {
    if (stopped) return;
    generation++;
    connecting = false;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    const active = client;
    client = null;
    if (active) {
      try {
        active.end(true);
      } catch {
        /* already closed */
      }
    }
    retry = 0;
    connect();
  };
  const resume = () => {
    if (
      document.hidden ||
      !navigator.onLine ||
      stopped ||
      connecting ||
      retryTimer
    )
      return;
    if (client?.connected && Date.now() - lastHeartbeat <= 180_000) return;
    reconnect();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  heartbeatWatch = setInterval(() => {
    if (client && Date.now() - lastHeartbeat > 180_000) {
      // A kiosk never leaves the page on its own; silence for three restart
      // cycles means the bridge is gone. Force a fresh connection instead of
      // only relabeling the status until the next visibility event.
      emit("stale");
      reconnect();
    }
  }, 30_000);
  connect();
  return {
    reconnect,
    stop: () => {
      if (stopped) return;
      stopped = true;
      generation++;
      connecting = false;
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      if (retryTimer) clearTimeout(retryTimer);
      if (heartbeatWatch) clearInterval(heartbeatWatch);
      const active = client;
      client = null;
      if (active) {
        try {
          active.end(true);
        } catch {
          /* already closed */
        }
      }
      emit("disconnected");
    },
  };
}
