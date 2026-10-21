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
import { finitePercent, record } from "../claude/extract";
import { MAX_INPUT_BYTES } from "../shared/input";

export const CODEX_USAGE_ENDPOINT =
  "https://chatgpt.com/backend-api/wham/usage";

const apiWindows = [
  ["primary_window", "5時間", 300],
  ["secondary_window", "7日間", 10080],
] as const;

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^\S+$/.test(value)
  );
}

function resetAfter(value: unknown, capturedAt: string): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 315576000
  )
    return null;
  const base = Date.parse(capturedAt);
  const reset = base + value * 1000;
  return Number.isFinite(base) && Number.isFinite(reset)
    ? new Date(reset).toISOString()
    : null;
}

export function normalizeCodexApi(raw: unknown, capturedAt: string): Usage {
  const root = record(raw);
  const limit = record(root.rate_limit);
  const windows = apiWindows
    .filter(([id]) => limit[id] && typeof limit[id] === "object")
    .map(([id, label, windowMinutes]) => {
      const value = record(limit[id]);
      return {
        id,
        label,
        usedPercent: finitePercent(value.used_percent),
        windowMinutes,
        resetsAt: resetAfter(value.reset_after_seconds, capturedAt),
      };
    });

  // plan_type is intentionally not forwarded: the dashboard contract only
  // needs the fixed provider and window metrics, and never relays raw account
  // response fields.
  return usageSchema.parse({
    ...emptyUsage("codex"),
    ...emptyCommon(windows.length ? "ok" : "missing"),
    capturedAt,
    sourceObservedAt: null,
    buckets: windows.length
      ? [{ id: "rate_limits", label: "Codex", windows }]
      : [],
  });
}

export async function readCodexOAuthToken(
  credentialsPath = join(homedir(), ".codex", "auth.json"),
  fallbackToken = process.env.OPENAI_API_KEY,
): Promise<string | undefined> {
  try {
    const root = record(JSON.parse(await readFile(credentialsPath, "utf8")));
    const tokens = record(root.tokens);
    if (validToken(tokens.access_token)) return tokens.access_token;
  } catch {
    // The environment fallback below is useful for API-key based Codex setups.
  }
  return validToken(fallbackToken) ? fallbackToken : undefined;
}

export type CodexApiFetchOptions = {
  capturedAt: string;
  oauthToken?: string;
  apiKey?: string;
  credentialsPath?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

class ReadFailure extends Error {
  constructor(readonly code: NonNullable<Common["errorCode"]>) {
    super(code);
  }
}

function failure(
  capturedAt: string,
  errorCode: NonNullable<Common["errorCode"]>,
  status: Common["status"] = "error",
): Usage {
  return usageSchema.parse({
    ...emptyUsage("codex"),
    ...emptyCommon(status),
    capturedAt,
    errorCode,
  });
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_INPUT_BYTES) {
    await response.body?.cancel();
    throw new ReadFailure("too_large");
  }
  if (!response.body) throw new ReadFailure("invalid_data");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ReadFailure("timeout");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new ReadFailure("timeout");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_INPUT_BYTES) {
        await reader.cancel();
        throw new ReadFailure("too_large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReadFailure("invalid_data");
  }
}

/** Fetch Codex's read-only usage endpoint with a fixed origin. */
export async function fetchCodexUsage(
  options: CodexApiFetchOptions,
): Promise<Usage> {
  const { capturedAt } = options;
  const token =
    options.oauthToken ??
    (await readCodexOAuthToken(options.credentialsPath, options.apiKey));
  if (!validToken(token))
    return failure(capturedAt, "unconfigured", "unconfigured");

  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return failure(capturedAt, "unconfigured", "unconfigured");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Usage>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failure(capturedAt, "timeout"));
    }, timeoutMs);
  });
  const request = async (): Promise<Usage> => {
    try {
      const response = await (options.fetch ?? globalThis.fetch)(
        CODEX_USAGE_ENDPOINT,
        {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
      );
      const blocked =
        response.redirected ||
        (response.url !== "" && response.url !== CODEX_USAGE_ENDPOINT) ||
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
      const raw = await readResponse(response, controller.signal);
      const value = normalizeCodexApi(raw, capturedAt);
      return value.status === "missing"
        ? failure(capturedAt, "invalid_data")
        : value;
    } catch (error) {
      return failure(
        capturedAt,
        controller.signal.aborted
          ? "timeout"
          : error instanceof ReadFailure
            ? error.code
            : "network",
      );
    }
  };
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
