import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import {
  compareUsageRevision,
  envelopeSchema,
  usageDeliverySchema,
  type UsageDelivery,
  type UsageEnvelope,
} from "../../../../packages/usage-contracts/src/index";

export function validateUsageBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw Error("invalid_usage_url");
  return url;
}
export async function readUsageReaderToken(path: string): Promise<string> {
  const info = await stat(path);
  if (
    !info.isFile() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw Error("usage_credentials_permissions");
  const { token } = z
    .object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/) })
    .parse(JSON.parse(await readFile(path, "utf8")));
  return token;
}
const mqttStatusSchema = z.object({
  schemaVersion: z.literal(1),
  publisher: z.enum(["ready", "disabled"]),
  reason: z
    .string()
    .regex(/^mqtt_credentials_[a-z_]+$/)
    .nullable(),
  runtime: z
    .object({
      state: z.enum(["stopped", "connecting", "connected", "reconnecting"]),
      connected: z.boolean(),
      reconnectCount: z.number().int().nonnegative(),
      currentRevision: z.string().nullable(),
      lastPublishAt: z.string().nullable(),
      lastPublishRevision: z.string().nullable(),
      lastHeartbeatAt: z.string().nullable(),
      lastError: z
        .enum(["publish_error", "ack_timeout", "connect_error"])
        .nullable(),
      lastErrorAt: z.string().nullable(),
      deliveryStatus: z.enum(["ok", "too_large"]),
    })
    .nullable(),
});
export type UsageClient = ReturnType<typeof createUsageClient>;
export function createUsageClient(options: {
  baseUrl: string;
  readerToken: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
}) {
  const base = validateUsageBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000,
    maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (
    !options.readerToken ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(maxBytes) ||
    maxBytes <= 0
  )
    throw Error("invalid_usage_client");
  let latest: UsageDelivery | undefined;
  let pending: Promise<UsageDelivery> | undefined;
  async function request(path: string, token: string, body?: UsageEnvelope) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL(path, base), {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status >= 300 && response.status < 400)
        throw Error("usage_redirect");
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw Error("too_large");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let count = 0;
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            count += part.value.byteLength;
            if (count > maxBytes) throw Error("too_large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return { response, value };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    readDelivery(): Promise<UsageDelivery> {
      if (pending) return pending;
      pending = (async () => {
        const { response, value } = await request(
          "/api/v1/usage",
          options.readerToken,
        );
        if (!response.ok) throw Error("usage_unavailable");
        const next = usageDeliverySchema.parse(value);
        if (latest) {
          const order = compareUsageRevision(latest, next);
          if (order === 1) return structuredClone(latest);
          if (order === 0 && JSON.stringify(latest) !== JSON.stringify(next))
            throw Error("usage_conflict");
        }
        latest = next;
        return structuredClone(next);
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async readMqttStatus() {
      const { response, value } = await request(
        "/api/v1/mqtt-status",
        options.readerToken,
      );
      if (!response.ok) throw Error("usage_unavailable");
      return mqttStatusSchema.parse(value);
    },
    async forwardUsage(
      input: UsageEnvelope,
      authorization: string | undefined,
    ) {
      const envelope = envelopeSchema.parse(input);
      const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(authorization ?? "");
      if (!match)
        return { statusCode: 401, body: { error: "authentication_required" } };
      const { response, value } = await request(
        "/api/v1/usage",
        match[1],
        envelope,
      );
      if (response.ok)
        return {
          statusCode: 200,
          body: z
            .object({ status: z.enum(["accepted", "duplicate", "older"]) })
            .parse(value),
        };
      const parsed = z
        .object({
          error: z.enum([
            "authentication_required",
            "forbidden",
            "source_denied",
            "invalid_data",
            "snapshot_conflict",
            "rate_limited",
            "storage_unavailable",
          ]),
        })
        .safeParse(value);
      if (
        ![400, 401, 403, 409, 413, 429, 503].includes(response.status) ||
        !parsed.success
      )
        throw Error("usage_unavailable");
      return { statusCode: response.status, body: parsed.data };
    },
  };
}
