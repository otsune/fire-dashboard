import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
it("records the GMKtec source alias on the snapshot and usage payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-gmktec-"));
  try {
    const snapshot = await captureClaude(
      raw,
      at,
      join(dir, "snapshot.json"),
      "gmktec",
    );
    expect(snapshot.sourceAlias).toBe("gmktec");
    expect(snapshot.payload.sourceAlias).toBe("gmktec");
    expect(snapshot.payload.provider).toBe("claude");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
it("reclaims a stale lock only from a dead holder identified by pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-stale-"));
  try {
    const path = join(dir, "snapshot.json");
    const dead = spawnSync("sh", ["-c", "exit 0"]);
    expect(dead.pid).toBeGreaterThan(0);
    // A stale holder: the pid no longer exists. The capture must recover.
    await mkdir(`${path}.lock`, { recursive: true });
    await writeFile(`${path}.lock/pid`, `${dead.pid}\n`);
    const recovered = await captureClaude(raw, at, path, "pc");
    expect(recovered.sequence).toBe(1);
    // A live holder is never stolen.
    await mkdir(`${path}.lock`, { recursive: true });
    await writeFile(`${path}.lock/pid`, `${process.pid}\n`);
    await expect(captureClaude(raw, at, path, "pc")).rejects.toThrow("storage");
    // A legacy lock without a pid file fails closed.
    await rm(`${path}.lock/pid`);
    await expect(captureClaude(raw, at, path, "pc")).rejects.toThrow("storage");
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
