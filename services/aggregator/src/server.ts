import Fastify from "fastify";
import { createUsageIngestor, createRateLimiter } from "./usage/ingest";
import type { Usage } from "../../../packages/contracts/src/index";
import {
  envelopeSchema,
  parseDashboard,
} from "../../../packages/contracts/src/index";
import type { Store } from "./store";
import type { Authorize, SourceAlias } from "./auth";
export function createServer(options: {
  store: Store;
  authorize: Authorize;
  sourceAlias?: SourceAlias;
  allowedOrigins?: string[];
  preferredSources?: Partial<
    Record<Usage["provider"], string | readonly string[]>
  >;
}) {
  if (typeof options.authorize !== "function")
    throw Error("authorization_required");
  const ingest = createUsageIngestor(
    options.store,
    options.preferredSources ?? {},
  );
  const accept = createRateLimiter();
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
    if (origin && !(options.allowedOrigins ?? []).includes(origin))
      return reply.code(403).send({ error: "origin_denied" });
    try {
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
  app.setErrorHandler((error, _req, reply) => {
    reply
      .code((error as { statusCode?: number }).statusCode === 413 ? 413 : 400)
      .send({
        error:
          (error as { statusCode?: number }).statusCode === 413
            ? "too_large"
            : "invalid_request",
      });
  });
  app.get("/api/v1/dashboard", async () =>
    parseDashboard(await options.store.readSnapshot()),
  );
  app.get("/api/v1/health", async () => ({ status: "ok", schemaVersion: 1 }));
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
      return {
        status: await ingest(parsed.data, new Date().toISOString(), alias),
      };
    } catch (error) {
      const code = (error as Error).message;
      return reply
        .code(code === "source_denied" ? 403 : 409)
        .send({
          error:
            code === "source_denied" ? "source_denied" : "snapshot_conflict",
        });
    }
  });
  return app;
}
