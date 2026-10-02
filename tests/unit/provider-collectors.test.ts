import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { extractAntigravity } from "../../collectors/antigravity/extract";
import { captureAntigravity } from "../../collectors/antigravity/statusline";
import { extractHermesNous } from "../../collectors/hermes-nous/extract";
import { captureHermesNous } from "../../collectors/hermes-nous/capture";
import {
  normalizeOpenCodeGo,
  fetchOpenCodeGo,
} from "../../collectors/opencode-go/adapter";
import { captureOpenCodeGo } from "../../collectors/opencode-go/capture";
import { readJsonInput } from "../../collectors/shared/input";

const at = "2026-10-02T12:00:00.000Z";
const reset = "2026-10-04T13:45:00.000Z";
// All account amounts, percentages and private strings below are synthetic.
const privateFields = {
  token: "SECRET",
  email: "private@example.test",
  cwd: "/private/repo",
  profile: { name: "PRIVATE" },
};
const antigravity = {
  ...privateFields,
  context_window: { used_percentage: 90 },
  quota: {
    "gemini-weekly": { remaining_fraction: 0.9378, reset_time: reset },
    "claude-bucket": { remaining_fraction: 0, reset_in_seconds: 3600 },
  },
};
const go = {
  ...privateFields,
  usage: {
    rolling: { status: "ok", percent: 20, resetsAt: reset },
    weekly: { status: "rate-limited", percent: 100, resetsAt: reset },
    monthly: {
      status: "ok",
      percent: 50,
      resetsAt: "2026-11-02T12:00:00.000Z",
    },
  },
};
const nous = {
  ...privateFields,
  ok: true,
  available: true,
  renews_at: reset,
  subscription_remaining_display: "$14.00",
  topup_remaining_display: "$12.00",
  total_spendable_display: "$26.00",
  plan_bar: {
    kind: "plan",
    remaining_display: "$14.00",
    total_display: "$20.00",
    spent_display: "$6.00",
    pct_used: 30,
    fill_fraction: 0.7,
  },
  topup_bar: {
    kind: "topup",
    remaining_display: "$12.00",
    total_display: "$12.00",
    spent_display: "$0.00",
    pct_used: null,
    fill_fraction: 1,
  },
};
function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const cliEnv = { PATH: process.env.PATH ?? "", OPENCODE_GO_API_KEY: "" };
function noPrivate(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(
    /SECRET|private@|PRIVATE|private\/repo|fill_fraction|context_window/,
  );
}

describe("Antigravity statusline collector", () => {
  it("converts remaining quota only and keeps unknown durations unknown", () => {
    const value = extractAntigravity(antigravity, at);
    expect(value.provider).toBe("antigravity");
    expect(value.status).toBe("ok");
    expect(value.buckets.map((b) => b.windows[0].usedPercent)).toEqual([
      6.22, 100,
    ]);
    expect(value.buckets[0].windows[0]).toMatchObject({
      resetsAt: reset,
      windowMinutes: null,
    });
    expect(value.buckets[1].windows[0].resetsAt).toBeNull();
    expect(value.capturedAt).toBe(at);
    expect(value.sourceObservedAt).toBeNull();
    noPrivate(value);
  });
  it.each([-0.1, 1.1, "0.8", null, NaN, Infinity])(
    "rejects invalid remaining fractions %s",
    (remaining_fraction) => {
      expect(
        extractAntigravity({ quota: { model: { remaining_fraction } } }, at)
          .buckets[0].windows[0].usedPercent,
      ).toBeNull();
    },
  );
  it("does not mistake context usage for quota or malformed values for buckets", () => {
    expect(
      extractAntigravity({ context_window: { used_percentage: 90 } }, at)
        .status,
    ).toBe("missing");
    expect(
      extractAntigravity({ quota: { bad: [], bad2: null, bad3: "value" } }, at)
        .buckets,
    ).toEqual([]);
  });
  it("prefers absolute reset, canonicalizes explicit offsets, rejects impossible dates and relative values", () => {
    const value = extractAntigravity(
      {
        quota: {
          one: {
            reset_time: "2026-10-04T15:45:00+02:00",
            reset_in_seconds: 999,
          },
          two: { reset_time: "2026-02-30T12:00:00Z", reset_in_seconds: -1 },
          three: { reset_in_seconds: Infinity },
        },
      },
      at,
    );
    expect(value.buckets.map((b) => b.windows[0].resetsAt)).toEqual([
      reset,
      null,
      null,
    ]);
  });
  it("never copies email, path or unrecognized account-like quota keys into labels", () => {
    const value = extractAntigravity(
      {
        quota: {
          "private@example.test": { remaining_fraction: 0.8 },
          "/private/repo": { remaining_fraction: 0.6 },
          PRIVATE: { remaining_fraction: 0.4 },
          "gemini-weekly": { remaining_fraction: 0.2 },
        },
      },
      at,
    );
    expect(value.buckets.map((b) => b.windows[0].usedPercent)).toEqual([
      20, 40, 60, 80,
    ]);
    expect(value.buckets[3].id).toBe("gemini-weekly");
    noPrivate(value);
  });
  it("bounds the number and size of source bucket identifiers", () => {
    const input = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `model-${i}${"a".repeat(3000)}`,
        { remaining_fraction: 1 },
      ]),
    );
    const value = extractAntigravity({ quota: input }, at);
    expect(value.buckets).toHaveLength(32);
    expect(
      value.buckets.every((b) => b.id.length <= 2048 && b.label.length <= 2048),
    ).toBe(true);
  });
});

describe("OpenCode Go collector", () => {
  it("uses the three official windows and exact resets without inventing a monthly duration", () => {
    const value = normalizeOpenCodeGo(go, at);
    expect(value.provider).toBe("opencode_go");
    expect(value.status).toBe("ok");
    expect(
      value.buckets[0].windows.map((w) => [w.id, w.usedPercent, w.resetsAt]),
    ).toEqual([
      ["rolling", 20, reset],
      ["weekly", 100, reset],
      ["monthly", 50, "2026-11-02T12:00:00.000Z"],
    ]);
    expect(value.buckets[0].windows[2].windowMinutes).toBeNull();
    expect(value.errorCode).toBe("rate_limited");
    expect(value.sourceObservedAt).toBeNull();
    noPrivate(value);
  });
  it("ignores unknown fields and invalid statuses without coercing percentages", () => {
    const value = normalizeOpenCodeGo(
      {
        usage: {
          rolling: { status: "unknown", percent: 40 },
          weekly: { status: "ok", percent: 101 },
          monthly: { status: "ok", percent: "50", resetsAt: "tomorrow" },
          account: { status: "ok", percent: 99 },
        },
      },
      at,
    );
    expect(
      value.buckets[0].windows.map((w) => [w.id, w.usedPercent, w.resetsAt]),
    ).toEqual([
      ["weekly", null, null],
      ["monthly", null, null],
    ]);
    expect(normalizeOpenCodeGo({}, at).status).toBe("missing");
  });
  it("requires a primitive official status instead of coercing arrays", () => {
    expect(
      normalizeOpenCodeGo(
        { usage: { rolling: { status: ["ok"], percent: 50 } } },
        at,
      ).buckets,
    ).toEqual([]);
  });
  it("fetches only the fixed HTTPS endpoint with injected bearer authorization and redirects blocked", async () => {
    const fetcher = vi.fn(async () => jsonResponse(go));
    const value = await fetchOpenCodeGo({
      capturedAt: at,
      apiKey: "synthetic-key",
      fetch: fetcher,
    });
    expect(value).toEqual(normalizeOpenCodeGo(go, at));
    expect(fetcher).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: "Bearer synthetic-key",
          Accept: "application/json",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    noPrivate(value);
    expect(JSON.stringify(value)).not.toContain("synthetic-key");
  });
  it.each([
    [401, "error", "auth"],
    [403, "error", "auth"],
    [429, "error", "rate_limited"],
    [500, "error", "network"],
    [302, "error", "blocked"],
  ])(
    "maps HTTP %s without leaking error body",
    async (code, status, errorCode) => {
      const value = await fetchOpenCodeGo({
        capturedAt: at,
        apiKey: "synthetic-key",
        fetch: async () => jsonResponse({ message: "SECRET" }, code as number),
      });
      expect(value).toMatchObject({
        status,
        errorCode,
        buckets: [],
        sourceObservedAt: null,
      });
      noPrivate(value);
    },
  );
  it.each([
    JSON.stringify({ error: { type: "AuthError", message: "SECRET" } }),
    JSON.stringify({ error: { type: "EntitlementError", message: "SECRET" } }),
    "<html>SECRET access denied by WAF</html>",
  ])(
    "treats a forbidden response conservatively and discards its body",
    async (body) => {
      const response = new Response(body, { status: 403 });
      const value = await fetchOpenCodeGo({
        capturedAt: at,
        apiKey: "synthetic-key",
        fetch: async () => response,
      });
      expect(value).toMatchObject({ status: "error", errorCode: "auth" });
      expect((await response.body!.getReader().read()).done).toBe(true);
      noPrivate(value);
    },
  );
  it("rejects a redirect or mismatched response origin and releases unused bodies", async () => {
    const response = jsonResponse(go);
    Object.defineProperty(response, "url", {
      value: "https://other.example.test/usage",
    });
    const value = await fetchOpenCodeGo({
      capturedAt: at,
      apiKey: "synthetic-key",
      fetch: async () => response,
    });
    expect(value.errorCode).toBe("blocked");
    expect(response.body?.locked).toBe(false);
    const denied = jsonResponse({ message: "SECRET" }, 401);
    await fetchOpenCodeGo({
      capturedAt: at,
      apiKey: "synthetic-key",
      fetch: async () => denied,
    });
    expect((await denied.body!.getReader().read()).done).toBe(true);
  });
  it.each([undefined, "", " bad key", "key\r\nInjected: x"])(
    "does not fetch with absent or invalid auth %s",
    async (apiKey) => {
      const fetcher = vi.fn();
      const value = await fetchOpenCodeGo({
        capturedAt: at,
        apiKey,
        fetch: fetcher,
      });
      expect(value.status).toBe("unconfigured");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("bounds a stalled fetch and sanitizes network failures", async () => {
    const value = await fetchOpenCodeGo({
      capturedAt: at,
      apiKey: "synthetic-key",
      timeoutMs: 5,
      fetch: () => new Promise(() => {}),
    });
    expect(value.errorCode).toBe("timeout");
    const failed = await fetchOpenCodeGo({
      capturedAt: at,
      apiKey: "synthetic-key",
      fetch: async () => {
        throw Error("SECRET synthetic-key");
      },
    });
    expect(failed.errorCode).toBe("network");
    noPrivate(failed);
  });
  it("bounds both declared and streamed response sizes", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    for (const response of [
      new Response(oversized),
      new Response("{}", { headers: { "content-length": "1048577" } }),
    ]) {
      const value = await fetchOpenCodeGo({
        capturedAt: at,
        apiKey: "synthetic-key",
        fetch: async () => response,
      });
      expect(value.errorCode).toBe("too_large");
    }
  });
  it("bounds body reads and rejects malformed JSON or response shape", async () => {
    const stalled = new Response(new ReadableStream({ start() {} }));
    const timed = await fetchOpenCodeGo({
      capturedAt: at,
      apiKey: "synthetic-key",
      timeoutMs: 5,
      fetch: async () => stalled,
    });
    expect(timed.errorCode).toBe("timeout");
    for (const response of [
      new Response("PRIVATE malformed"),
      jsonResponse({ account: "SECRET" }),
      jsonResponse(null),
    ]) {
      const value = await fetchOpenCodeGo({
        capturedAt: at,
        apiKey: "synthetic-key",
        fetch: async () => response,
      });
      expect(value.errorCode).toBe("invalid_data");
      noPrivate(value);
    }
  });
});

describe("Hermes Nous usage.bars collector", () => {
  it("keeps purchased balance separate from the verified subscription quota", () => {
    const value = extractHermesNous(nous, at);
    expect(value.provider).toBe("hermes_nous");
    expect(value.status).toBe("ok");
    expect(value.balance).toEqual({
      currency: "USD",
      subscriptionRemaining: 14,
      purchasedRemaining: 12,
      totalRemaining: 26,
      monthlyAllowance: 20,
      renewsAt: reset,
    });
    expect(value.buckets).toHaveLength(1);
    expect(value.buckets[0].windows).toEqual([
      {
        id: "monthly",
        label: "月間枠",
        usedPercent: 30,
        windowMinutes: null,
        resetsAt: reset,
      },
    ]);
    expect(value.sourceObservedAt).toBeNull();
    noPrivate(value);
  });
  it("accepts a standard JSON-RPC result envelope", () => {
    expect(
      extractHermesNous({ jsonrpc: "2.0", id: 1, result: nous }, at),
    ).toEqual(extractHermesNous(nous, at));
  });
  it("never turns a purchased-only full bar into a quota", () => {
    const value = extractHermesNous(
      { ...nous, plan_bar: null, subscription_remaining_display: null },
      at,
    );
    expect(value.buckets).toEqual([]);
    expect(value.balance).toMatchObject({
      monthlyAllowance: null,
      purchasedRemaining: 12,
    });
  });
  it.each([0, null, -1, Infinity, "20"])(
    "does not use untrusted allowance %s",
    (total_display) => {
      const value = extractHermesNous(
        { ...nous, plan_bar: { ...nous.plan_bar, total_display } },
        at,
      );
      expect(value.buckets).toEqual([]);
      expect(value.balance?.purchasedRemaining).toBe(12);
    },
  );
  it.each([-1, 101, null, "30", NaN, Infinity])(
    "does not invent a quota for invalid pct_used %s",
    (pct_used) => {
      expect(
        extractHermesNous(
          { ...nous, plan_bar: { ...nous.plan_bar, pct_used } },
          at,
        ).buckets,
      ).toEqual([]);
    },
  );
  it("requires a coherent allowance, remaining balance and source percentage", () => {
    for (const raw of [
      { ...nous, subscription_remaining_display: "$21.00" },
      { ...nous, plan_bar: { ...nous.plan_bar, kind: "topup" } },
      { ...nous, plan_bar: { ...nous.plan_bar, pct_used: 90 } },
      { ...nous, plan_bar: { ...nous.plan_bar, remaining_display: "$15.00" } },
    ])
      expect(extractHermesNous(raw, at).buckets).toEqual([]);
  });
  it("parses bounded formatted dollar amounts and leaves date-only renewal unknown", () => {
    const value = extractHermesNous(
      {
        ...nous,
        plan_bar: null,
        subscription_remaining_display: "$1,234.56",
        topup_remaining_display: "$-2.00",
        total_spendable_display: "$nan",
        renews_at: "2026-11-02",
      },
      at,
    );
    expect(value.balance).toEqual({
      currency: "USD",
      subscriptionRemaining: 1234.56,
      purchasedRemaining: null,
      totalRemaining: null,
      monthlyAllowance: null,
      renewsAt: null,
    });
    expect(
      extractHermesNous(
        {
          ...nous,
          plan_bar: null,
          subscription_remaining_display: "$12,34.00",
          topup_remaining_display: null,
          total_spendable_display: null,
        },
        at,
      ).balance,
    ).toBeUndefined();
  });
  it("reports unavailable data without raw account or gateway errors", () => {
    for (const raw of [
      { ok: true, available: false },
      {},
      { ok: true, available: true },
    ])
      expect(extractHermesNous(raw, at).status).toBe("missing");
    const value = extractHermesNous(
      { ok: false, error: "PRIVATE", message: "SECRET" },
      at,
    );
    expect(value.status).toBe("error");
    noPrivate(value);
  });
});

describe("provider capture boundary", () => {
  it("parses bounded stdin without retaining raw input", async () => {
    expect(await readJsonInput(Readable.from(['{"ok":', "true}"]))).toEqual({
      ok: true,
    });
    await expect(
      readJsonInput(Readable.from(["x".repeat(1024 * 1024 + 1)])),
    ).rejects.toThrow("too_large");
    await expect(
      readJsonInput(Readable.from(["SECRET malformed"])),
    ).rejects.toThrow("invalid_data");
  });
  it("counts UTF-8 bytes and safely joins a split multibyte character", async () => {
    const bytes = Buffer.from('{"text":"あ"}');
    expect(
      await readJsonInput(
        Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]),
      ),
    ).toEqual({ text: "あ" });
    await expect(
      readJsonInput(Readable.from(["あ".repeat(400000)])),
    ).rejects.toThrow("too_large");
  });
  it("replaying relative-only quota input preserves the original snapshot identity and capture time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-relative-replay-"));
    try {
      const path = join(dir, "snapshot.json");
      const input = {
        quota: {
          "gemini-weekly": { remaining_fraction: 0.8, reset_in_seconds: 3600 },
        },
      };
      const first = await captureAntigravity(input, at, path, "pc");
      const replay = await captureAntigravity(
        input,
        "2026-10-02T13:00:00.000Z",
        path,
        "pc",
      );
      expect(replay.snapshotId).toBe(first.snapshotId);
      expect(replay.sequence).toBe(first.sequence);
      expect(replay.payload.capturedAt).toBe(at);
      expect(replay.payload.buckets[0].windows[0].resetsAt).toBeNull();
      expect(replay).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("persists only selected normalized fields and preserves identity across identical captures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-capture-"));
    try {
      const agPath = join(dir, "ag.json");
      const first = await captureAntigravity(antigravity, at, agPath, "pc");
      const duplicate = await captureAntigravity(antigravity, at, agPath, "pc");
      expect(duplicate).toEqual(first);
      const hermes = await captureHermesNous(
        nous,
        at,
        join(dir, "hermes.json"),
        "pc",
      );
      const fetched = await captureOpenCodeGo({
        capturedAt: at,
        path: join(dir, "go.json"),
        sourceAlias: "pc",
        apiKey: "synthetic-key",
        fetch: async () => jsonResponse(go),
      });
      for (const value of [first, hermes, fetched]) {
        noPrivate(value);
        expect(value.sourceAlias).toBe("pc");
      }
      for (const name of ["ag.json", "hermes.json", "go.json"])
        noPrivate(JSON.parse(await readFile(join(dir, name), "utf8")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("runs the Go CLI only with a child-process mock and never persists its key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-go-cli-"));
    try {
      const path = join(dir, "snapshot.json");
      const stub = join(dir, "mock-fetch.mjs");
      await writeFile(
        stub,
        `globalThis.fetch = async (url, init) => {
        if (url !== "https://opencode.ai/zen/go/v1/usage" || init.headers.Authorization !== "Bearer synthetic-key" || init.redirect !== "error") throw Error("invalid request");
        return new Response(${JSON.stringify(JSON.stringify(go))}, { status: 200 });
      };`,
      );
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          pathToFileURL(stub).href,
          "collectors/opencode-go/capture.ts",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...cliEnv,
            OPENCODE_GO_API_KEY: "synthetic-key",
            FIRE_SNAPSHOT_PATH: path,
            FIRE_SOURCE_ALIAS: "pc",
          },
        },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe("");
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.payload.provider).toBe("opencode_go");
      expect(JSON.stringify(saved)).not.toContain("synthetic-key");
      noPrivate(saved);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writes a safe unconfigured Go snapshot when no key was explicitly supplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-go-unconfigured-"));
    try {
      const path = join(dir, "snapshot.json");
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "collectors/opencode-go/capture.ts"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...cliEnv, FIRE_SNAPSHOT_PATH: path, FIRE_SOURCE_ALIAS: "pc" },
        },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toBe("Fire Dashboard: local snapshot unavailable\n");
      expect(JSON.parse(await readFile(path, "utf8")).payload.status).toBe(
        "unconfigured",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not leak malformed stdin into CLI diagnostics", () => {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "collectors/hermes-nous/capture.ts"],
      {
        cwd: process.cwd(),
        input: "SECRET malformed",
        encoding: "utf8",
        env: {
          ...cliEnv,
          FIRE_SNAPSHOT_PATH: "/unused.json",
          FIRE_SOURCE_ALIAS: "pc",
        },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("Fire Dashboard: local snapshot unavailable\n");
  });
  it.each([
    ["antigravity/statusline.ts", antigravity, "antigravity"],
    ["hermes-nous/capture.ts", nous, "hermes_nous"],
  ])("runs the %s stdin CLI", async (entry, input, provider) => {
    const dir = await mkdtemp(join(tmpdir(), "provider-cli-"));
    try {
      const path = join(dir, "snapshot.json");
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", `collectors/${entry}`],
        {
          cwd: process.cwd(),
          input: JSON.stringify(input),
          encoding: "utf8",
          env: { ...cliEnv, FIRE_SNAPSHOT_PATH: path, FIRE_SOURCE_ALIAS: "pc" },
        },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe("");
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.payload.provider).toBe(provider);
      noPrivate(saved);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
