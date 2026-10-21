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
import { finitePercent, record } from "./extract";
import { isoInstant, MAX_INPUT_BYTES } from "../shared/input";

export const CLAUDE_USAGE_ENDPOINT =
  "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

const apiWindows = [
  ["five_hour", "5時間", 300],
  ["seven_day", "7日間", 10080],
] as const;

export function normalizeClaudeApi(raw: unknown, capturedAt: string): Usage {
  const root = record(raw);
  const windows = apiWindows
    .filter(([id]) => root[id] && typeof root[id] === "object")
    .map(([id, label, windowMinutes]) => {
      const value = record(root[id]);
      return {
        id,
        label,
        usedPercent: finitePercent(value.utilization),
        windowMinutes,
        resetsAt: isoInstant(value.resets_at),
      };
    });

  return usageSchema.parse({
    ...emptyUsage("claude"),
    ...emptyCommon(windows.length ? "ok" : "missing"),
    capturedAt,
    sourceObservedAt: null,
    buckets: windows.length
      ? [{ id: "rate_limits", label: "利用上限", windows }]
      : [],
  });
}

export async function readClaudeOAuthToken(
  credentialsPath = join(homedir(), ".claude", ".credentials.json"),
): Promise<string | undefined> {
  try {
    const root = record(JSON.parse(await readFile(credentialsPath, "utf8")));
    const oauth = record(root.claudeAiOauth);
    const token = oauth.accessToken;
    return typeof token === "string" &&
      token.length <= 4096 &&
      /^\S+$/.test(token)
      ? token
      : undefined;
  } catch {
    return undefined;
  }
}

export type ClaudeApiFetchOptions = {
  capturedAt: string;
  oauthToken?: string;
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
    ...emptyUsage("claude"),
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

/** Fetch Claude Code's read-only OAuth usage endpoint with a fixed origin. */
export async function fetchClaudeUsage(
  options: ClaudeApiFetchOptions,
): Promise<Usage> {
  const { capturedAt } = options;
  const oauthToken =
    options.oauthToken ?? (await readClaudeOAuthToken(options.credentialsPath));
  if (!oauthToken || oauthToken.length > 4096 || !/^\S+$/.test(oauthToken))
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
        CLAUDE_USAGE_ENDPOINT,
        {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${oauthToken}`,
            "anthropic-beta": OAUTH_BETA,
            Accept: "application/json",
          },
        },
      );
      const blocked =
        response.redirected ||
        (response.url !== "" && response.url !== CLAUDE_USAGE_ENDPOINT) ||
        (response.status >= 300 && response.status < 400);
      if (blocked || !response.ok) {
        await response.body?.cancel();
        if (blocked) return failure(capturedAt, "blocked");
        if (response.status === 401 || response.status === 403)
          return failure(capturedAt, "auth");
        if (response.status === 429) return failure(capturedAt, "rate_limited");
        return failure(capturedAt, "network");
      }
      const raw = await readResponse(response, controller.signal);
      const value = normalizeClaudeApi(raw, capturedAt);
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
