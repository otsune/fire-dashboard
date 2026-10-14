import { randomUUID } from "node:crypto";
import mqtt from "mqtt";
import type { Store } from "../store";
import {
  usageAvailabilitySchema,
  usageDeliverySchema,
  usageHeartbeatSchema,
} from "../../../../packages/contracts/src/index";

export const DEFAULT_MQTT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 60_000;
const ACK_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 5_000;

type PublishCallback = (error?: Error) => void;
type MqttClientLike = {
  on: (event: string, listener: (...args: any[]) => void) => void;
  publish: (
    topic: string,
    payload: string,
    options: { qos: 1; retain: boolean },
    callback?: PublishCallback,
  ) => void;
  end: (
    force?: boolean,
    options?: Record<string, unknown>,
    callback?: () => void,
  ) => MqttClientLike;
  removeAllListeners?: () => void;
};
export type MqttClientFactory = (
  url: string,
  options: Record<string, unknown>,
) => MqttClientLike;

export type MqttPublisherOptions = {
  url: string;
  username?: string;
  password?: string;
  topicPrefix?: string;
  maxPayloadBytes?: number;
  heartbeatMs?: number;
  clientId?: string;
  clientFactory?: MqttClientFactory;
};

export type MqttPublisherRuntimeStatus = {
  state: "stopped" | "connecting" | "connected" | "reconnecting";
  connected: boolean;
  reconnectCount: number;
  currentRevision: string | null;
  lastPublishAt: string | null;
  lastPublishRevision: string | null;
  lastHeartbeatAt: string | null;
  lastError: "publish_error" | "ack_timeout" | "connect_error" | null;
  lastErrorAt: string | null;
  deliveryStatus: "ok" | "too_large";
};

export type UsagePublisher = {
  start: () => void;
  notify: () => void;
  stop: () => Promise<void>;
  status?: () => MqttPublisherRuntimeStatus;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function boundedDelay(attempt: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

/**
 * Publishes the canonical usage state without putting network I/O in the
 * Store update queue. MQTT.js is injected in tests so broker failures can be
 * exercised without requiring a local broker.
 */
export function createMqttPublisher(
  store: Store,
  options: MqttPublisherOptions,
): UsagePublisher {
  const prefix = (options.topicPrefix ?? "fire-dashboard/v1/main").replace(
    /\/+$/,
    "",
  );
  const topics = {
    state: `${prefix}/usage/state`,
    availability: `${prefix}/usage/availability`,
    heartbeat: `${prefix}/usage/heartbeat`,
  };
  const maxPayloadBytes =
    options.maxPayloadBytes ?? DEFAULT_MQTT_MAX_PAYLOAD_BYTES;
  const heartbeatMs = Math.max(1000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const factory = options.clientFactory ?? ((url, clientOptions) =>
    mqtt.connect(url, clientOptions) as unknown as MqttClientLike);
  const instanceId = options.clientId ?? randomUUID();
  let client: MqttClientLike | null = null;
  let started = false;
  let stopping = false;
  let connected = false;
  let connectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stateInFlight = false;
  let pendingState: string | null = null;
  let pendingRevision: string | null = null;
  let stateAckTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInFlight = false;
  let heartbeatAckTimer: ReturnType<typeof setTimeout> | undefined;
  let deliveryStatus: "ok" | "too_large" = "ok";
  let runtimeState: MqttPublisherRuntimeStatus["state"] = "stopped";
  let connectionStarted = false;
  let reconnectCount = 0;
  let currentRevision: string | null = null;
  let lastPublishAt: string | null = null;
  let lastPublishRevision: string | null = null;
  let lastHeartbeatAt: string | null = null;
  let lastError: MqttPublisherRuntimeStatus["lastError"] = null;
  let lastErrorAt: string | null = null;

  const clearAckTimers = () => {
    if (stateAckTimer) clearTimeout(stateAckTimer);
    if (heartbeatAckTimer) clearTimeout(heartbeatAckTimer);
    stateAckTimer = undefined;
    heartbeatAckTimer = undefined;
    stateInFlight = false;
    heartbeatInFlight = false;
  };
  const currentHeartbeat = async () => {
    const state = await store.inspect((value) => ({
      streamId: value.streamId,
      revision: value.usageRevision,
    }));
    const value = usageHeartbeatSchema.parse({
      schemaVersion: 1,
      streamId: state.streamId,
      revision: state.revision,
      instanceId,
      sentAt: new Date().toISOString(),
      deliveryStatus,
    });
    return json(value);
  };
  const disconnectAndReconnect = () => {
    if (!client || stopping) return;
    runtimeState = "reconnecting";
    const old = client;
    client = null;
    connected = false;
    clearAckTimers();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (started && !stopping) scheduleConnect();
    };
    const timer = setTimeout(() => {
      try {
        old.end(true);
      } catch {
        /* The transport is already unusable. */
      }
      finish();
    }, DISCONNECT_TIMEOUT_MS);
    try {
      // An intentional reconnect uses MQTT DISCONNECT.  Do not retain an
      // offline transition here; availability should describe shutdown or
      // an actually lost transport, while heartbeat covers liveness.
      old.end(false, {}, finish);
    } catch {
      finish();
    }
  };
  const failPublish = (
    reason: "publish_error" | "ack_timeout" | "connect_error" = "publish_error",
  ) => {
    lastError = reason;
    lastErrorAt = new Date().toISOString();
    disconnectAndReconnect();
  };
  const markStatePublishSuccess = (revision: string | null) => {
    lastPublishAt = new Date().toISOString();
    if (revision) lastPublishRevision = revision;
  };
  const markHeartbeatSuccess = () => {
    lastHeartbeatAt = new Date().toISOString();
  };
  const publishHeartbeat = async () => {
    if (!client || !connected || heartbeatInFlight || stopping) return;
    let payload: string;
    try {
      payload = await currentHeartbeat();
    } catch {
      return;
    }
    if (Buffer.byteLength(payload, "utf8") > maxPayloadBytes) return;
    const active = client;
    heartbeatInFlight = true;
    try {
      active.publish(topics.heartbeat, payload, { qos: 1, retain: false }, (error) => {
        if (active !== client) return;
        if (heartbeatAckTimer) clearTimeout(heartbeatAckTimer);
        heartbeatAckTimer = undefined;
        heartbeatInFlight = false;
        if (error) failPublish();
        else markHeartbeatSuccess();
      });
      heartbeatAckTimer = setTimeout(() => {
        if (active === client && heartbeatInFlight) failPublish("ack_timeout");
      }, ACK_TIMEOUT_MS);
    } catch {
      failPublish();
    }
  };
  const publishNextState = () => {
    if (!client || !connected || stateInFlight || !pendingState || stopping) return;
    const payload = pendingState;
    const revision = pendingRevision;
    pendingState = null;
    pendingRevision = null;
    const active = client;
    stateInFlight = true;
    try {
      active.publish(topics.state, payload, { qos: 1, retain: true }, (error) => {
        if (active !== client) return;
        if (stateAckTimer) clearTimeout(stateAckTimer);
        stateAckTimer = undefined;
        stateInFlight = false;
        if (error) {
          // Keep the latest state; the timed-out connection must not invoke a
          // stale callback that could move the retained value backwards.
          if (revision) pendingRevision = revision;
          pendingState = pendingState ?? payload;
          failPublish();
          return;
        }
        if (!currentRevision || revision === currentRevision)
          deliveryStatus = "ok";
        markStatePublishSuccess(revision);
        publishNextState();
      });
      stateAckTimer = setTimeout(() => {
        if (active === client && stateInFlight) {
          if (revision) pendingRevision = revision;
          pendingState = pendingState ?? payload;
          failPublish("ack_timeout");
        }
      }, ACK_TIMEOUT_MS);
    } catch {
      if (revision) pendingRevision = revision;
      pendingState = pendingState ?? payload;
      failPublish();
    }
  };
  const queueCurrentState = async () => {
    let payload: string | null = null;
    let revision: string | null = null;
    try {
      const value = await store.inspect((state) => {
        const metadata = state.dashboard.usageDelivery;
        if (!metadata) return null;
        const delivery = usageDeliverySchema.parse({
          ...metadata,
          usage: state.dashboard.usage,
        });
        return { payload: json(delivery), revision: metadata.revision };
      });
      if (value) {
        ({ payload, revision } = value);
        currentRevision = revision;
      } else {
        currentRevision = null;
      }
    } catch {
      return;
    }
    if (!payload || !revision) return;
    if (Buffer.byteLength(payload, "utf8") > maxPayloadBytes) {
      pendingState = null;
      pendingRevision = null;
      deliveryStatus = "too_large";
      void publishHeartbeat();
      return;
    }
    // Coalescing happens before checking connection so a reconnect publishes
    // only the latest committed state.
    pendingState = payload;
    pendingRevision = revision;
    publishNextState();
  };
  const publishOnline = () => {
    if (!client || !connected) return;
    const payload = json(
      usageAvailabilitySchema.parse({
        schemaVersion: 1,
        instanceId,
        status: "online",
        sentAt: new Date().toISOString(),
      }),
    );
    try {
      client.publish(topics.availability, payload, { qos: 1, retain: true });
    } catch {
      failPublish();
    }
  };
  const publishOffline = (active: MqttClientLike) => {
    try {
      active.publish(
        topics.availability,
        json({
          schemaVersion: 1,
          instanceId,
          status: "offline",
          sentAt: new Date().toISOString(),
        }),
        { qos: 1, retain: true },
      );
    } catch {
      /* LWT remains the fallback for a failed transport. */
    }
  };
  const scheduleConnect = () => {
    if (!started || stopping || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, boundedDelay(connectAttempt++));
  };
  const connect = () => {
    if (!started || stopping || client) return;
    if (connectionStarted) {
      runtimeState = "reconnecting";
      reconnectCount++;
    } else {
      runtimeState = "connecting";
      connectionStarted = true;
    }
    const will = json({
      schemaVersion: 1,
      instanceId,
      status: "offline",
      sentAt: new Date().toISOString(),
    });
    try {
      const next = factory(options.url, {
        protocolVersion: 4,
        clean: true,
        clientId: instanceId,
        username: options.username,
        password: options.password,
        reconnectPeriod: 0,
        will: { topic: topics.availability, payload: will, qos: 1, retain: true },
      });
      client = next;
      next.on("connect", () => {
        if (next !== client) return;
        connected = true;
        runtimeState = "connected";
        connectAttempt = 0;
        publishOnline();
        void queueCurrentState();
        void publishHeartbeat();
      });
      next.on("close", () => {
        if (next !== client) return;
        connected = false;
        client = null;
        clearAckTimers();
        if (started && !stopping) runtimeState = "reconnecting";
        scheduleConnect();
      });
      next.on("error", () => {
        if (next === client) failPublish(connected ? "publish_error" : "connect_error");
      });
      next.on("offline", () => {
        if (next === client) {
          connected = false;
          runtimeState = "reconnecting";
          // mqtt.js may report offline without a following close event when
          // the initial connection fails. Detach this client explicitly so
          // the application-owned reconnect schedule can replace it.
          disconnectAndReconnect();
        }
      });
    } catch {
      scheduleConnect();
    }
  };
  return {
    start: () => {
      if (started) return;
      started = true;
      runtimeState = "connecting";
      heartbeatTimer = setInterval(() => void publishHeartbeat(), heartbeatMs);
      connect();
    },
    notify: () => {
      if (!started || stopping) return;
      void queueCurrentState();
    },
    stop: async () => {
      if (stopping) return;
      stopping = true;
      started = false;
      runtimeState = "stopped";
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clearAckTimers();
      const active = client;
      client = null;
      connected = false;
      if (!active) return;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            active.end(true);
          } catch {
            /* already closed */
          }
          finish();
        }, DISCONNECT_TIMEOUT_MS);
        try {
          publishOffline(active);
          active.end(false, {}, finish);
        } catch {
          finish();
        }
      });
    },
    status: () => ({
      state: runtimeState,
      connected,
      reconnectCount,
      currentRevision,
      lastPublishAt,
      lastPublishRevision,
      lastHeartbeatAt,
      lastError,
      lastErrorAt,
      deliveryStatus,
    }),
  };
}
