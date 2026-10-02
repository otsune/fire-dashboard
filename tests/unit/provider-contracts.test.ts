import { describe, it, expect } from "vitest";
import {
  emptyDashboard,
  emptyUsage,
  parseDashboard,
  usageSchema,
} from "../../packages/contracts/src/index";
import { configSchema } from "../../services/aggregator/src/config";
import { createUsageIngestor } from "../../services/aggregator/src/usage/ingest";
import { createMemoryStore } from "../../services/aggregator/src/store";

const providers = [
  "claude",
  "codex",
  "antigravity",
  "opencode_go",
  "hermes_nous",
] as const;
const at = "2026-10-02T00:00:00.000Z";
const balance = {
  currency: "USD",
  subscriptionRemaining: 14,
  purchasedRemaining: 12,
  totalRemaining: 26,
  monthlyAllowance: 20,
  renewsAt: at,
};
describe("provider contracts", () => {
  it("defaults to five distinct unconfigured providers without fabricated values", () => {
    expect(emptyDashboard().usage.map((u) => u.provider)).toEqual(providers);
    for (const u of emptyDashboard().usage) {
      expect(u.status).toBe("unconfigured");
      expect(u.buckets).toEqual([]);
      expect(u.sourceObservedAt).toBeNull();
    }
  });
  it.each(providers)(
    "validates %s through the existing transport contract",
    (provider) => {
      expect(
        usageSchema.parse({ ...emptyUsage("claude"), provider }).provider,
      ).toBe(provider);
      expect(
        configSchema.parse({ preferredSources: { [provider]: "local-pc" } })
          .preferredSources,
      ).toEqual({ [provider]: "local-pc" });
    },
  );
  it("preserves legacy payloads without requiring balances", () => {
    const old = {
      ...emptyDashboard(),
      usage: [emptyUsage("claude"), emptyUsage("codex")],
    };
    expect(parseDashboard(old).usage).toEqual(old.usage);
  });
  it("retains the correct provider on an invalid known-provider row", () => {
    const d = parseDashboard({
      ...emptyDashboard(),
      usage: [{ provider: "antigravity", buckets: "broken" }],
    });
    expect(d.usage[0].provider).toBe("antigravity");
    expect(d.usage[0].errorCode).toBe("invalid_data");
  });
  it("never attributes unknown-provider data to Claude", () => {
    const d = parseDashboard({
      ...emptyDashboard(),
      usage: [{ provider: "unknown", token: "secret" }, null],
    });
    expect(d.usage).toEqual([]);
  });
  it("retains explicit USD balances while stripping arbitrary account fields", () => {
    const result = usageSchema.parse({
      ...emptyUsage("claude"),
      provider: "hermes_nous",
      balance: { ...balance, token: "secret" },
      email: "private@example.invalid",
    });
    expect(result).toHaveProperty("balance", balance);
    expect(JSON.stringify(result)).not.toMatch(/secret|private/);
  });
  it.each([-1, Infinity, NaN, "20"])(
    "rejects invalid monetary values %s",
    (value) => {
      expect(
        usageSchema.safeParse({
          ...emptyUsage("claude"),
          balance: { ...balance, totalRemaining: value },
        }).success,
      ).toBe(false);
    },
  );
  it("retains null balances and rejects unknown currencies", () => {
    const missing = {
      ...balance,
      subscriptionRemaining: null,
      purchasedRemaining: null,
      totalRemaining: null,
      monthlyAllowance: null,
      renewsAt: null,
    };
    expect(
      usageSchema.parse({ ...emptyUsage("claude"), balance: missing }),
    ).toHaveProperty("balance", missing);
    expect(
      usageSchema.safeParse({
        ...emptyUsage("claude"),
        balance: { ...balance, currency: "TOKENS" },
      }).success,
    ).toBe(false);
  });
  it("keeps provider sequence streams isolated and display order stable", async () => {
    const store = createMemoryStore();
    const ingest = createUsageIngestor(store, {
      claude: "pc",
      antigravity: "pc",
      opencode_go: "pc",
      hermes_nous: "pc",
    });
    for (const provider of [
      "hermes_nous",
      "antigravity",
      "opencode_go",
      "claude",
    ] as const) {
      const payload = usageSchema.parse({
        ...emptyUsage("claude"),
        provider,
        sourceAlias: "pc",
        capturedAt: at,
      });
      await ingest(
        { snapshotId: provider, sequence: 1, sourceAlias: "pc", payload },
        at,
        "pc",
      );
    }
    expect((await store.readSnapshot()).usage.map((u) => u.provider)).toEqual(
      providers,
    );
    const payload = usageSchema.parse({
      ...emptyUsage("claude"),
      provider: "opencode_go",
      sourceAlias: "other",
    });
    await expect(
      ingest(
        { snapshotId: "forged", sequence: 2, sourceAlias: "other", payload },
        at,
        "other",
      ),
    ).rejects.toThrow("source_denied");
  });
});
it("does not carry a previous source's balance into a new preferred source failure", async () => {
  const store = createMemoryStore();
  const first = usageSchema.parse({
    ...emptyUsage("hermes_nous"),
    status: "ok",
    sourceAlias: "old-pc",
    capturedAt: at,
    balance,
  });
  await createUsageIngestor(store, { hermes_nous: "old-pc" })(
    { snapshotId: "old", sequence: 1, sourceAlias: "old-pc", payload: first },
    at,
    "old-pc",
  );
  const failed = usageSchema.parse({
    ...emptyUsage("hermes_nous"),
    status: "error",
    errorCode: "auth",
    sourceAlias: "new-pc",
    capturedAt: at,
  });
  await createUsageIngestor(store, { hermes_nous: "new-pc" })(
    { snapshotId: "new", sequence: 1, sourceAlias: "new-pc", payload: failed },
    at,
    "new-pc",
  );
  const current = (await store.readSnapshot()).usage.find(
    (u) => u.provider === "hermes_nous",
  )!;
  expect(current.sourceAlias).toBe("new-pc");
  expect(current.status).toBe("error");
  expect(current.balance).toBeUndefined();
  expect(current.buckets).toEqual([]);
});
it("restores an unchanged previously accepted snapshot when its source becomes preferred again", async () => {
  const store = createMemoryStore();
  const oldPayload = usageSchema.parse({
    ...emptyUsage("hermes_nous"),
    status: "ok",
    sourceAlias: "old-pc",
    capturedAt: at,
    balance,
  });
  const original = {
    snapshotId: "old",
    sequence: 1,
    sourceAlias: "old-pc",
    payload: oldPayload,
  };
  await createUsageIngestor(store, { hermes_nous: "old-pc" })(
    original,
    at,
    "old-pc",
  );
  const newPayload = usageSchema.parse({
    ...oldPayload,
    sourceAlias: "new-pc",
    balance: { ...balance, totalRemaining: 50 },
  });
  await createUsageIngestor(store, { hermes_nous: "new-pc" })(
    {
      snapshotId: "new",
      sequence: 1,
      sourceAlias: "new-pc",
      payload: newPayload,
    },
    at,
    "new-pc",
  );
  const later = "2026-10-02T01:00:00.000Z";
  expect(
    await createUsageIngestor(store, { hermes_nous: "old-pc" })(
      original,
      later,
      "old-pc",
    ),
  ).toBe("duplicate");
  const current = (await store.readSnapshot()).usage.find(
    (u) => u.provider === "hermes_nous",
  )!;
  expect(current.sourceAlias).toBe("old-pc");
  expect(current.balance?.totalRemaining).toBe(26);
  expect(current.capturedAt).toBe(at);
  expect(current.sourceObservedAt).toBeNull();
  expect(current.receivedAt).toBe(later);
});
