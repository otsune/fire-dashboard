import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractClaude } from "../../collectors/claude/extract";
import { captureClaude } from "../../collectors/claude/statusline";
const at = "2026-10-02T00:00:00.000Z";
const raw = {
  rate_limits: {
    five_hour: { used_percentage: 35, resets_at: 1790900000 },
    seven_day: { used_percentage: 50, resets_at: 1791400000 },
    spend_limit: { used_percentage: 87 },
  },
  cwd: "/private/repo",
  token: "SECRET",
  email: "person@example.com",
  transcript: "PRIVATE",
};
it("extracts only rate limits with no invented observation timestamp", () => {
  const u = extractClaude(raw, at);
  expect(u.status).toBe("ok");
  expect(u.buckets[0].windows.map((w) => w.usedPercent)).toEqual([35, 50]);
  expect(u.buckets[0].windows[0].resetsAt).toBe(
    new Date(1790900000 * 1000).toISOString(),
  );
  expect(u.sourceObservedAt).toBeNull();
  expect(JSON.stringify(u)).not.toMatch(
    /SECRET|person@|PRIVATE|repo|spend_limit/,
  );
});
it("distinguishes missing unsupported and invalid values", () => {
  expect(extractClaude({}, at).status).toBe("missing");
  expect(
    extractClaude({ rate_limits: { five_hour: { used_percentage: 101 } } }, at)
      .buckets[0].windows[0].usedPercent,
  ).toBeNull();
});
it("preserves snapshot ID/capturedAt across redraws but sequences changed values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-capture-"));
  try {
    const path = join(dir, "snapshot.json");
    const first = await captureClaude(raw, at, path, "pc");
    const duplicate = await captureClaude(
      raw,
      "2026-10-02T00:01:00.000Z",
      path,
      "pc",
    );
    expect(duplicate).toEqual(first);
    const changed = await captureClaude(
      { rate_limits: { five_hour: { used_percentage: 36 } } },
      "2026-10-02T00:02:00.000Z",
      path,
      "pc",
    );
    expect(changed.sequence).toBe(first.sequence + 1);
    expect(changed.snapshotId).not.toBe(first.snapshotId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("concurrent snapshots fail closed instead of racing sequence assignment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-race-"));
  try {
    const path = join(dir, "snapshot.json");
    const results = await Promise.allSettled([
      captureClaude(raw, at, path, "pc"),
      captureClaude(raw, at, path, "pc"),
    ]);
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);
    const final = await captureClaude(raw, at, path, "pc");
    expect(final.sequence).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
