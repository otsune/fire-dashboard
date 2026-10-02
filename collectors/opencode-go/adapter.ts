import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Common,
  type Usage,
} from "../../packages/contracts/src/index";
import { finitePercent, record } from "../claude/extract";
import { isoInstant, MAX_INPUT_BYTES } from "../shared/input";

const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
const windows = [
  ["rolling", "短期枠"],
  ["weekly", "週間枠"],
  ["monthly", "月間枠"],
] as const;

export function normalizeOpenCodeGo(raw: unknown, capturedAt: string): Usage {
  const source = record(record(raw).usage);
  const selected = windows
    .filter(([id]) => {
      const status = record(source[id]).status;
      return status === "ok" || status === "rate-limited";
    })
    .map(([id, label]) => {
      const value = record(source[id]);
      return {
        id,
        label,
        usedPercent: finitePercent(value.percent),
        windowMinutes: null,
        resetsAt: isoInstant(value.resetsAt),
      };
    });
  const rateLimited = windows.some(
    ([id]) => record(source[id]).status === "rate-limited",
  );
  return usageSchema.parse({
    ...emptyUsage("opencode_go"),
    ...emptyCommon(selected.length ? "ok" : "missing"),
    capturedAt,
    sourceObservedAt: null,
    errorCode: rateLimited ? "rate_limited" : null,
    buckets: selected.length
      ? [{ id: "go", label: "Go 利用枠", windows: selected }]
      : [],
  });
}
export type GoFetchOptions = {
  capturedAt: string;
  apiKey?: string;
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
    ...emptyUsage("opencode_go"),
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

/** Read-only fixed-origin GET; callers supply auth explicitly and tests inject fetch. */
export async function fetchOpenCodeGo(options: GoFetchOptions): Promise<Usage> {
  const { capturedAt, apiKey } = options;
  if (!apiKey || apiKey.length > 4096 || !/^\S+$/.test(apiKey))
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
      const response = await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });
      const blocked =
        response.redirected ||
        (response.url !== "" && response.url !== ENDPOINT) ||
        (response.status >= 300 && response.status < 400);
      if (blocked || !response.ok) {
        // Error bodies may contain account identifiers and are never read or persisted.
        await response.body?.cancel();
        if (blocked) return failure(capturedAt, "blocked");
        if (response.status === 401) return failure(capturedAt, "auth");
        // A bare 403 may be an auth, proxy or temporary entitlement failure;
        // it cannot establish permanent lack of support. Keep last-known usage.
        if (response.status === 403) return failure(capturedAt, "auth");
        if (response.status === 429) return failure(capturedAt, "rate_limited");
        return failure(capturedAt, "network");
      }
      const raw = await readResponse(response, controller.signal);
      const value = normalizeOpenCodeGo(raw, capturedAt);
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
