import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Common,
  type Usage,
} from "../../packages/contracts/src/index";
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
      const legacy = scope === "https://accounts.x.ai/sign-in" || scope.includes("/sign-in");
      if (!oidc && !legacy) return [];
      const expired = expiry(entry.expires_at) <= Date.now();
      return [{ token, oidc, expired, expiresAt: expiry(entry.expires_at), scope }];
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

function readVarint(bytes: Uint8Array, index: { value: number }): number | null {
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

type Fixed32Field = { path: number[]; value: number; order: number };
type VarintField = { path: number[]; value: number };

function scanProtobuf(
  data: Uint8Array,
  depth: number,
  path: number[],
  order: { value: number },
  output: { fixed32: Fixed32Field[]; varints: VarintField[] },
): boolean {
  const index = { value: 0 };
  while (index.value < data.length) {
    const fieldStart = index.value;
    const key = readVarint(data, index);
    if (key === null || key === 0) return false;
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (!field) return false;
    const fieldPath = [...path, field];
    if (wire === 0) {
      const value = readVarint(data, index);
      if (value === null) return false;
      output.varints.push({ path: fieldPath, value });
    } else if (wire === 1) {
      if (index.value + 8 > data.length) return false;
      index.value += 8;
    } else if (wire === 2) {
      const length = readVarint(data, index);
      if (length === null || length > data.length - index.value) return false;
      const end = index.value + length;
      if (depth < 4)
        scanProtobuf(data.subarray(index.value, end), depth + 1, fieldPath, order, output);
      index.value = end;
    } else if (wire === 5) {
      if (index.value + 4 > data.length) return false;
      const view = new DataView(data.buffer, data.byteOffset + index.value, 4);
      const value = view.getFloat32(0, true);
      output.fixed32.push({ path: fieldPath, value, order: order.value++ });
      index.value += 4;
    } else {
      // A malformed field must not cause a scan to walk arbitrary bytes.
      index.value = fieldStart;
      return false;
    }
  }
  return true;
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

function grpcStatus(data: Uint8Array, headers?: Headers): { code: number; message: string } | null {
  const fields = grpcTrailerFields(data);
  const raw = headers?.get("grpc-status") ?? fields["grpc-status"];
  if (raw === null || raw === undefined || raw === "") return null;
  const code = Number(raw);
  return Number.isFinite(code)
    ? { code, message: headers?.get("grpc-message") ?? fields["grpc-message"] ?? "" }
    : null;
}

export type GrokUsageSnapshot = { usedPercent: number; resetsAt: string | null };

/** Extract the stable usage fields from the gRPC-web protobuf response. */
export function parseGrokUsageResponse(
  data: Uint8Array,
  now = new Date(),
): GrokUsageSnapshot {
  const status = grpcStatus(data);
  if (status && status.code !== 0) throw Error(`grpc_${status.code}`);
  let payloads = grpcWebDataFrames(data);
  if (!payloads.length && looksLikeProtobuf(data)) payloads = [data];
  if (!payloads.length) throw Error("invalid_data");

  const output = { fixed32: [] as Fixed32Field[], varints: [] as VarintField[] };
  const order = { value: 0 };
  for (const payload of payloads) scanProtobuf(payload, 0, [], order, output);
  const candidates = output.fixed32
    .filter(
      (field) =>
        field.path.at(-1) === 1 &&
        Number.isFinite(field.value) &&
        field.value >= 0 &&
        field.value <= 100,
    )
    .sort((a, b) => a.path.length - b.path.length || a.order - b.order);
  const usedPercent = candidates[0]?.value;
  const resets = output.varints
    .filter(
      (field) =>
        field.value >= 1_700_000_000 &&
        field.value <= 2_100_000_000 &&
        field.value * 1000 > now.getTime(),
    )
    .sort((a, b) => a.value - b.value);
  const preferred = resets.find(
    (field) => field.path.length === 3 && field.path[0] === 1 && field.path[1] === 5 && field.path[2] === 1,
  );
  // Proto3 omits a zero-valued fixed32 field. A valid period marker plus a
  // future reset is therefore the only safe way to recognize an unused pool.
  const hasUsagePeriod = output.varints.some(
    (field) =>
      (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6) ||
      (field.path.length === 3 &&
        field.path[0] === 1 &&
        field.path[1] === 8 &&
        field.path[2] === 1 &&
        (field.value === 1 || field.value === 2)),
  );
  const noUsageYet =
    usedPercent === undefined &&
    output.fixed32.length === 0 &&
    resets.length > 0 &&
    hasUsagePeriod;
  if (usedPercent === undefined && !noUsageYet) throw Error("invalid_data");
  return {
    usedPercent: usedPercent ?? 0,
    resetsAt: (preferred ?? resets[0])
      ? new Date((preferred ?? resets[0]).value * 1000).toISOString()
      : null,
  };
}

function failure(
  capturedAt: string,
  errorCode: NonNullable<Common["errorCode"]>,
  status: Common["status"] = "error",
): Usage {
  return usageSchema.parse({ ...emptyUsage("grok"), ...emptyCommon(status), capturedAt, errorCode });
}

export function normalizeGrokUsage(snapshot: GrokUsageSnapshot, capturedAt: string): Usage {
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

async function readResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
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

export async function fetchGrokUsage(options: GrokApiFetchOptions): Promise<Usage> {
  const { capturedAt } = options;
  const token = options.accessToken ?? (await readGrokAccessToken(options.credentialsPath));
  if (!validToken(token)) return failure(capturedAt, "unconfigured", "unconfigured");
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return failure(capturedAt, "unconfigured", "unconfigured");

  const controller = new AbortController();
  const request = (async (): Promise<Usage> => {
    try {
    const response = await (options.fetch ?? globalThis.fetch)(GROK_USAGE_ENDPOINT, {
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
    });
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
      return failure(capturedAt, grpc.code === 16 || grpc.code === 7 ? "auth" : "network");
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
