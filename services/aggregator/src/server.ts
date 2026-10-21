import Fastify from "fastify";
import type { Usage } from "../../../packages/contracts/src/index";
import {
  envelopeSchema,
  parseDashboard,
  usageProviders,
  emptyUsage,
} from "../../../packages/contracts/src/index";
import type { Store } from "./store";
import type { Authorize, AuthorizeAdmin, SourceAlias } from "./auth";
import { z } from "zod";
import { createWeatherCatalog, type WeatherCatalog } from "./weather/catalog";
import {
  createWeatherSettings,
  type WeatherSettingsService,
} from "./weather/settings";
import type { UsageClient } from "./usage/client";
import { registerUsageRelay } from "./usage/relay";
export function createServer(options: {
  store: Store;
  authorize: Authorize;
  authorizeAdmin?: AuthorizeAdmin;
  weatherCatalog?: WeatherCatalog;
  weatherSettings?: WeatherSettingsService;
  sourceAlias?: SourceAlias;
  allowedOrigins?: string[];
  usageClient?: UsageClient;
  usageRelay?: { baseUrl: string; readerToken: string; origin: string; maxPayloadBytes?: number; maxConnections?: number };
}) {
  if (typeof options.authorize !== "function")
    throw Error("authorization_required");
  const catalog = options.weatherCatalog ?? createWeatherCatalog();
  const settings =
    options.weatherSettings ??
    createWeatherSettings({ store: options.store, catalog });
  const canEdit = async (req: Parameters<AuthorizeAdmin>[0]) =>
    req.headers.authorization === undefined &&
    !!(await options.authorizeAdmin?.(req));
  const weatherError = (
    error: unknown,
    reply: import("fastify").FastifyReply,
  ) => {
    const code = (error as Error).message;
    const status =
      code === "revision_conflict" ? 409 : code === "invalid_data" ? 400 : 503;
    return reply.code(status).send({
      error:
        status === 503
          ? code === "catalog_unavailable"
            ? code
            : "storage_unavailable"
          : code,
    });
  };
  const allowedOrigins =
    options.allowedOrigins ?? [];
  const app = Fastify({ logger: false, bodyLimit: 65536, trustProxy: false });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("cache-control", "no-store")
      .header(
        "content-security-policy",
        "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      )
      .header("x-content-type-options", "nosniff");
    const origin = req.headers.origin;
    const adminRoute =
      (["GET", "HEAD"].includes(req.method) &&
        req.routeOptions.url === "/api/v1/weather-catalog") ||
      (req.method === "PUT" &&
        req.routeOptions.url === "/api/v1/weather-settings");
    if (
      req.method === "PUT" &&
      req.routeOptions.url === "/api/v1/weather-settings"
    ) {
      if (!origin || !allowedOrigins.includes(origin))
        return reply.code(403).send({ error: "origin_denied" });
      if (
        req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      )
        return reply.code(400).send({ error: "invalid_data" });
    }
    if (origin && !allowedOrigins.includes(origin))
      return reply.code(403).send({ error: "origin_denied" });
    try {
      if (adminRoute) {
        if (await canEdit(req)) return;
        const authenticated =
          (await options.authorize(req, "reader")) ||
          (await options.authorize(req, "collector"));
        return reply.code(authenticated ? 403 : 401).send({
          error: authenticated ? "forbidden" : "authentication_required",
        });
      }
      const role = req.method === "POST" ? "collector" : "reader";
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
  app.setErrorHandler((error, req, reply) => {
    reply
      .code((error as { statusCode?: number }).statusCode === 413 ? 413 : 400)
      .send({
        error:
          (error as { statusCode?: number }).statusCode === 413
            ? "too_large"
            : req.method === "PUT" &&
                req.routeOptions.url === "/api/v1/weather-settings"
              ? "invalid_data"
              : "invalid_request",
      });
  });
  let lastUsage: Awaited<ReturnType<UsageClient["readDelivery"]>> | undefined;
  app.get("/api/v1/dashboard", async () => {
    const snapshot = parseDashboard(await options.store.readSnapshot());
    let usageConnection: "connected" | "unavailable" | "unconfigured" = options.usageClient ? "unavailable" : "unconfigured";
    if (options.usageClient) {
      try { lastUsage = await options.usageClient.readDelivery(); usageConnection = "connected"; }
      catch { /* Retain canonical values and observation times. */ }
    }
    // Legacy Fire state never becomes the source of truth for usage again.
    const { usageDelivery: _legacy, ...local } = snapshot;
    return { ...local, usageConnection,
      usage: lastUsage?.usage ?? usageProviders.map(emptyUsage),
      ...(lastUsage ? { usageDelivery: { schemaVersion: 1, streamId: lastUsage.streamId, revision: lastUsage.revision, publishedAt: lastUsage.publishedAt } } : {}),
    };
  });
  app.get("/api/v1/health", async () => ({ status: "ok", schemaVersion: 1 }));
  app.get("/api/v1/mqtt-status", async (_req, reply) => {
    try { if (options.usageClient) return await options.usageClient.readMqttStatus(); }
    catch { /* No backend diagnostics or secrets are reflected. */ }
    return reply.code(503).send({ error: "usage_unavailable" });
  });
  app.get("/api/v1/weather-settings", async (req, reply) => {
    try {
      const saved = await settings.read();
      let editable = false;
      try {
        editable = await canEdit(req);
      } catch {
        /* Fail closed without hiding a reader's selection. */
      }
      return { ...saved.settings, canEdit: editable, weather: saved.weather };
    } catch (error) {
      return weatherError(error, reply);
    }
  });
  app.get("/api/v1/weather-catalog", async (req, reply) => {
    const query = z
      .strictObject({
        office: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_data" });
    try {
      return query.data.office
        ? await catalog.office(query.data.office)
        : await catalog.offices();
    } catch (error) {
      return weatherError(error, reply);
    }
  });
  app.put("/api/v1/weather-settings", async (req, reply) => {
    try {
      return await settings.save(req.body);
    } catch (error) {
      return weatherError(error, reply);
    }
  });
  app.post("/api/v1/usage", async (req, reply) => {
    const parsed = envelopeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_data" });
    const alias = await options.sourceAlias?.(req);
    if (!alias || alias !== parsed.data.sourceAlias)
      return reply.code(403).send({ error: "source_denied" });
    if (!options.usageClient) return reply.code(503).send({ error: "usage_unavailable" });
    try {
      const result = await options.usageClient.forwardUsage(parsed.data, req.headers.authorization);
      if (result.statusCode === 429) reply.header("retry-after", "1");
      return reply.code(result.statusCode).send(result.body);
    } catch { return reply.code(503).send({ error: "usage_unavailable" }); }
  });
  if (options.usageRelay) registerUsageRelay(app, options.usageRelay);
  return app;
}
