import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Common,
  type Usage,
} from "../../packages/usage-contracts/src/index";
import { MAX_INPUT_BYTES } from "../shared/input";

/** The endpoint used by Settings → Usage on grok.com. It is undocumented. */
export const GROK_USAGE_ENDPOINT =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

const EMPTY_GRPC_WEB_BODY = new Uint8Array([0, 0, 0, 0, 0]);

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^\S+$/.test(value)
  );
}

function expiry(value: unknown): number {
  if (typeof value !== "string") return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** Read only the bearer token from the official ~/.grok/auth.json shape. */
export async function readGrokAccessToken(
  credentialsPath = join(homedir(), ".grok", "auth.json"),
): Promise<string | undefined> {
  try {
    const root = record(JSON.parse(await readFile(credentialsPath, "utf8")));
    const direct = [root.access_token, root.accessToken, root.token, root.key];
    for (const candidate of direct) if (validToken(candidate)) return candidate;

    const candidates = Object.entries(root).flatMap(([scope, value]) => {
      const entry = record(value);
      const token = entry.key;
      if (!validToken(token)) return [];
      const oidc = scope.startsWith("https://auth.x.ai::");
      const legacy =
        scope === "https://accounts.x.ai/sign-in" || scope.includes("/sign-in");
      if (!oidc && !legacy) return [];
      const expired = expiry(entry.expires_at) <= Date.now();
      return [
        { token, oidc, expired, expiresAt: expiry(entry.expires_at), scope },
      ];
    });
    candidates.sort(
      (a, b) =>
        Number(a.expired) - Number(b.expired) ||
        Number(b.oidc) - Number(a.oidc) ||
        b.expiresAt - a.expiresAt ||
        a.scope.localeCompare(b.scope),
    );
    return candidates[0]?.token;
  } catch {
    return undefined;
  }
}

function readVarint(
  bytes: Uint8Array,
  index: { value: number },
): number | null {
  let value = 0;
  let multiplier = 1;
  for (let count = 0; index.value < bytes.length && count < 10; count++) {
    const byte = bytes[index.value++];
    value += (byte & 0x7f) * multiplier;
    if (value > Number.MAX_SAFE_INTEGER) return null;
    if ((byte & 0x80) === 0) return value;
    multiplier *= 128;
  }
  return null;
}

type ProtoField = { wire: number; value: number | Uint8Array };
// Decode only one message level. Unknown strings/bytes are never recursively
// searched for coincidental floats or timestamps.
function protobufFields(data: Uint8Array): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  const index = { value: 0 };
  while (index.value < data.length) {
    const key = readVarint(data, index);
    if (key === null || key < 8) throw Error("invalid_data");
    const id = Math.floor(key / 8),
      wire = key & 7;
    let value: number | Uint8Array;
    if (wire === 0) {
      const parsed = readVarint(data, index);
      if (parsed === null) throw Error("invalid_data");
      value = parsed;
    } else if (wire === 2) {
      const length = readVarint(data, index);
      if (length === null || length > data.length - index.value)
        throw Error("invalid_data");
      value = data.subarray(index.value, index.value + length);
      index.value += length;
    } else if (wire === 5 || wire === 1) {
      const length = wire === 5 ? 4 : 8;
      if (index.value + length > data.length) throw Error("invalid_data");
      value =
        wire === 5
          ? new DataView(
              data.buffer,
              data.byteOffset + index.value,
              4,
            ).getFloat32(0, true)
          : data.subarray(index.value, index.value + 8);
      index.value += length;
    } else throw Error("invalid_data");
    fields.set(id, [...(fields.get(id) ?? []), { wire, value }]);
  }
  return fields;
}
function one(
  fields: Map<number, ProtoField[]>,
  id: number,
  wire: number,
  required = true,
): ProtoField | undefined {
  const values = fields.get(id) ?? [];
  if (
    values.length > 1 ||
    (required && !values.length) ||
    (values[0] && values[0].wire !== wire)
  )
    throw Error("invalid_data");
  return values[0];
}
function nestedFields(fields: Map<number, ProtoField[]>, id: number) {
  return protobufFields(one(fields, id, 2)!.value as Uint8Array);
}

function grpcWebDataFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let index = 0;
  while (index + 5 <= data.length) {
    const flags = data[index];
    const length =
      data[index + 1] * 0x1000000 +
      data[index + 2] * 0x10000 +
      data[index + 3] * 0x100 +
      data[index + 4];
    const start = index + 5;
    const end = start + length;
    if (end > data.length) return [];
    if ((flags & 0x80) === 0) frames.push(data.subarray(start, end));
    index = end;
  }
  return index === data.length ? frames : [];
}

function looksLikeProtobuf(data: Uint8Array): boolean {
  if (!data.length) return false;
  const field = data[0] >>> 3;
  const wire = data[0] & 7;
  return field > 0 && [0, 1, 2, 5].includes(wire);
}

function grpcTrailerFields(data: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {};
  let index = 0;
  while (index + 5 <= data.length) {
    const flags = data[index];
    const length =
      data[index + 1] * 0x1000000 +
      data[index + 2] * 0x10000 +
      data[index + 3] * 0x100 +
      data[index + 4];
    const start = index + 5;
    const end = start + length;
    if (end > data.length) break;
    if ((flags & 0x80) !== 0) {
      const text = new TextDecoder().decode(data.subarray(start, end));
      for (const line of text.split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator > 0)
          fields[line.slice(0, separator).trim().toLowerCase()] = line
            .slice(separator + 1)
            .trim();
      }
    }
    index = end;
  }
  return fields;
}

function grpcStatus(
  data: Uint8Array,
  headers?: Headers,
): { code: number; message: string } | null {
  const fields = grpcTrailerFields(data);
  const raw = headers?.get("grpc-status") ?? fields["grpc-status"];
  if (raw === null || raw === undefined || raw === "") return null;
  const code = Number(raw);
  return Number.isFinite(code)
    ? {
        code,
        message: headers?.get("grpc-message") ?? fields["grpc-message"] ?? "",
      }
    : null;
}

export type GrokUsageSnapshot = {
  usedPercent: number;
  resetsAt: string | null;
};

/** Extract the known usage fields; the clock argument remains for compatibility.
 * Past reset timestamps are preserved so the display can mark them awaiting update.
 */
export function parseGrokUsageResponse(
  data: Uint8Array,
  _now = new Date(),
): GrokUsageSnapshot {
  const status = grpcStatus(data);
  if (status && status.code !== 0) throw Error(`grpc_${status.code}`);
  let payloads = grpcWebDataFrames(data);
  if (!payloads.length && looksLikeProtobuf(data)) payloads = [data];
  if (!payloads.length) throw Error("invalid_data");

  if (payloads.length !== 1) throw Error("invalid_data");
  const pool = nestedFields(protobufFields(payloads[0]), 1);
  const reset = one(nestedFields(pool, 5), 1, 0)!.value as number;
  if (reset < 1_700_000_000 || reset > 2_100_000_000)
    throw Error("invalid_data");
  const percent = one(pool, 1, 5, false)?.value as number | undefined;
  const period = one(pool, 6, 0, false)?.value;
  const structuredPeriod = pool.has(8)
    ? one(nestedFields(pool, 8), 1, 0)?.value
    : undefined;
  if (
    percent === undefined &&
    period !== 1 &&
    period !== 2 &&
    structuredPeriod !== 1 &&
    structuredPeriod !== 2
  )
    throw Error("invalid_data");
  if (
    percent !== undefined &&
    (!Number.isFinite(percent) || percent < 0 || percent > 100)
  )
    throw Error("invalid_data");
  return {
    usedPercent: percent ?? 0,
    resetsAt: new Date(reset * 1000).toISOString(),
  };
}

function failure(
  capturedAt: string,
  errorCode: NonNullable<Common["errorCode"]>,
  status: Common["status"] = "error",
): Usage {
  return usageSchema.parse({
    ...emptyUsage("grok"),
    ...emptyCommon(status),
    capturedAt,
    errorCode,
  });
}

export function normalizeGrokUsage(
  snapshot: GrokUsageSnapshot,
  capturedAt: string,
): Usage {
  return usageSchema.parse({
    ...emptyUsage("grok"),
    ...emptyCommon("ok"),
    capturedAt,
    buckets: [
      {
        id: "usage",
        label: "Grok",
        windows: [
          {
            id: "weekly",
            label: "週間利用枠",
            usedPercent: snapshot.usedPercent,
            windowMinutes: null,
            resetsAt: snapshot.resetsAt,
          },
        ],
      },
    ],
  });
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_INPUT_BYTES) {
    await response.body?.cancel();
    throw Error("too_large");
  }
  if (!response.body) throw Error("invalid_data");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw Error("timeout");
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INPUT_BYTES) {
        await reader.cancel();
        throw Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export type GrokApiFetchOptions = {
  capturedAt: string;
  accessToken?: string;
  credentialsPath?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export async function fetchGrokUsage(
  options: GrokApiFetchOptions,
): Promise<Usage> {
  const { capturedAt } = options;
  const token =
    options.accessToken ?? (await readGrokAccessToken(options.credentialsPath));
  if (!validToken(token))
    return failure(capturedAt, "unconfigured", "unconfigured");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return failure(capturedAt, "unconfigured", "unconfigured");

  const controller = new AbortController();
  const request = (async (): Promise<Usage> => {
    try {
      const response = await (options.fetch ?? globalThis.fetch)(
        GROK_USAGE_ENDPOINT,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "*/*",
            "Content-Type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "x-user-agent": "connect-es/2.1.1",
            Origin: "https://grok.com",
            Referer: "https://grok.com/?_s=usage",
          },
          body: EMPTY_GRPC_WEB_BODY,
        },
      );
      const blocked =
        response.redirected ||
        (response.url !== "" && response.url !== GROK_USAGE_ENDPOINT) ||
        (response.status >= 300 && response.status < 400);
      if (blocked || !response.ok) {
        await response.body?.cancel();
        if (blocked) return failure(capturedAt, "blocked");
        if (response.status === 401 || response.status === 403)
          return failure(capturedAt, "auth");
        if (response.status === 404)
          return failure(capturedAt, "unsupported", "unsupported");
        if (response.status === 429) return failure(capturedAt, "rate_limited");
        return failure(capturedAt, "network");
      }
      const body = await readResponse(response, controller.signal);
      const grpc = grpcStatus(body, response.headers);
      if (grpc && grpc.code !== 0)
        return failure(
          capturedAt,
          grpc.code === 16 || grpc.code === 7 ? "auth" : "network",
        );
      try {
        return normalizeGrokUsage(parseGrokUsageResponse(body), capturedAt);
      } catch {
        return failure(capturedAt, "invalid_data");
      }
    } catch (error) {
      return failure(
        capturedAt,
        controller.signal.aborted
          ? "timeout"
          : error instanceof Error &&
              ["too_large", "invalid_data"].includes(error.message)
            ? (error.message as NonNullable<Common["errorCode"]>)
            : "network",
      );
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Usage>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failure(capturedAt, "timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
