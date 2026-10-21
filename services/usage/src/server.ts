import Fastify from "fastify";
import {
  envelopeSchema,
  type UsageProvider,
} from "../../../packages/usage-contracts/src/index";
import { createUsageIngestorWithRevision, createRateLimiter } from "./ingest";
import {
  createMqttPublisher,
  type MqttPublisherOptions,
  type UsagePublisher,
} from "./mqtt/publisher";
import { registerMqttGateway, type MqttGatewayOptions } from "./mqtt/gateway";
import type { UsageStore } from "./store";
import type { Authorize, SourceAlias } from "./auth";

export type MqttPublisherStatus = {
  state: "disabled" | "ready";
  reason?: string;
};
export function createUsageServer(options: {
  store: UsageStore;
  authorize: Authorize;
  sourceAlias?: SourceAlias;
  allowedOrigins?: readonly string[];
  preferredSources?: Partial<Record<UsageProvider, string | readonly string[]>>;
  mqtt?: MqttPublisherOptions;
  mqttStatus?: MqttPublisherStatus;
  usagePublisher?: UsagePublisher;
  gateway?: MqttGatewayOptions;
}) {
  if (typeof options.authorize !== "function")
    throw Error("authorization_required");
  const app = Fastify({ logger: false, bodyLimit: 65536, trustProxy: false });
  const ingest = createUsageIngestorWithRevision(
    options.store,
    options.preferredSources ?? {},
  );
  const accept = createRateLimiter();
  const publisher =
    options.usagePublisher ??
    (options.mqtt
      ? createMqttPublisher(options.store, options.mqtt)
      : undefined);
  const status = options.mqttStatus ?? {
    state: options.mqtt ? "ready" : "disabled",
  };
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header(
        "content-security-policy",
        "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    if (
      req.headers.origin &&
      !(options.allowedOrigins ?? []).includes(req.headers.origin)
    )
      return reply.code(403).send({ error: "origin_denied" });
    const role = req.method === "POST" ? "collector" : "reader";
    try {
      if (!(await options.authorize(req, role))) {
        const other = await options.authorize(
          req,
          role === "reader" ? "collector" : "reader",
        );
        return reply
          .code(other ? 403 : 401)
          .send({ error: other ? "forbidden" : "authentication_required" });
      }
    } catch {
      return reply.code(401).send({ error: "authentication_required" });
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    const tooLarge = (error as { statusCode?: number }).statusCode === 413;
    reply
      .code(tooLarge ? 413 : 400)
      .send({ error: tooLarge ? "too_large" : "invalid_request" });
  });
  app.get("/api/v1/health", async () => ({ status: "ok", schemaVersion: 1 }));
  app.get("/api/v1/usage", async () => options.store.readDelivery());
  app.get("/api/v1/mqtt-status", async () => ({
    schemaVersion: 1,
    publisher: status.state,
    reason: "reason" in status ? (status.reason ?? null) : null,
    runtime: publisher?.status?.() ?? null,
  }));
  app.post("/api/v1/usage", async (req, reply) => {
    const parsed = envelopeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_data" });
    const alias = await options.sourceAlias?.(req);
    if (!alias || alias !== parsed.data.sourceAlias)
      return reply.code(403).send({ error: "source_denied" });
    if (!accept(alias))
      return reply
        .code(429)
        .header("retry-after", "1")
        .send({ error: "rate_limited" });
    try {
      const result = await ingest(parsed.data, new Date().toISOString(), alias);
      if (result.revisionChanged) publisher?.notify();
      return { status: result.status };
    } catch (error) {
      const code = (error as Error).message;
      const status =
        code === "source_denied"
          ? 403
          : code === "snapshot_conflict"
            ? 409
            : 503;
      return reply
        .code(status)
        .send({ error: status === 503 ? "storage_unavailable" : code });
    }
  });
  if (options.gateway)
    registerMqttGateway(app, {
      ...options.gateway,
      readerTopicPrefix:
        options.mqtt?.topicPrefix ??
        options.gateway.readerTopicPrefix ??
        "ai-usage/v1/main",
    });
  if (publisher) {
    app.addHook("onClose", async () => publisher.stop());
    publisher.start();
  }
  return app;
}
