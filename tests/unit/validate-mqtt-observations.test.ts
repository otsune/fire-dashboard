import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const validator = join(process.cwd(), "scripts/validate-mqtt-observations.mjs");
type CommandResult = { code: number; stdout: string; stderr: string };

const claudeRow = (observedAt: string) => ({
  observedAt,
  mqttFooter: true,
  mqttStatus: {
    runtime: { state: "connected", deliveryStatus: "ok", reconnectCount: 0 },
  },
  health: { status: "ok" },
  claude: { status: "ok", sourceAlias: "gmktec" },
});

const fireRow = (observedAt: string) => ({
  observedAt,
  mqttFooter: true,
  mqttStatus: {
    runtime: { state: "connected", deliveryStatus: "ok", reconnectCount: 0 },
  },
  health: { status: "ok" },
});

const hostRow = (observedAt: string) => ({
  observedAt,
  api: { ActiveState: "active", SubState: "running", NRestarts: "0" },
  claudeSender: { ActiveState: "active", SubState: "running", NRestarts: "0" },
  netdev: { enp3s0: { rxBytes: 1, txBytes: 1 } },
  claudeSnapshot: { provider: "claude", sourceAlias: "gmktec" },
});

async function writeLogs(directory: string, times: string[]) {
  const paths = {
    claude: join(directory, "claude.jsonl"),
    fire: join(directory, "fire.jsonl"),
    host: join(directory, "host.jsonl"),
  };
  await Promise.all([
    writeFile(
      paths.claude,
      `${times.map((time) => JSON.stringify(claudeRow(time))).join("\n")}\n`,
    ),
    writeFile(
      paths.fire,
      `${times.map((time) => JSON.stringify(fireRow(time))).join("\n")}\n`,
    ),
    writeFile(
      paths.host,
      `${times.map((time) => JSON.stringify(hostRow(time))).join("\n")}\n`,
    ),
  ]);
  return paths;
}

async function runValidator(args: string[]): Promise<CommandResult> {
  try {
    const result = await execFile(process.execPath, [validator, ...args]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 2,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

it("fails the requested minimum observation duration and reports each duration", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "mqtt-observation-validator-"),
  );
  try {
    const paths = await writeLogs(directory, [
      "2026-10-15T00:00:00.000Z",
      "2026-10-15T00:30:00.000Z",
    ]);
    const result = await runValidator([
      "--claude",
      paths.claude,
      "--fire",
      paths.fire,
      "--host",
      paths.host,
      "--min-hours",
      "1",
    ]);
    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout ?? "{}");
    expect(summary.claude.durationHours).toBe(0.5);
    expect(summary.fire.durationHours).toBe(0.5);
    expect(summary.host.durationHours).toBe(0.5);
    expect(summary.durationGate).toEqual({ requiredHours: 1, passed: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails an excessive observation gap when a maximum interval is requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mqtt-observation-gap-"));
  try {
    const paths = await writeLogs(directory, [
      "2026-10-15T00:00:00.000Z",
      "2026-10-15T00:30:00.000Z",
      "2026-10-15T01:00:00.000Z",
    ]);
    const result = await runValidator([
      "--claude",
      paths.claude,
      "--fire",
      paths.fire,
      "--host",
      paths.host,
      "--max-gap-minutes",
      "10",
    ]);
    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout ?? "{}");
    expect(summary.claude.maxGapMinutes).toBe(30);
    expect(summary.fire.maxGapMinutes).toBe(30);
    expect(summary.host.maxGapMinutes).toBe(30);
    expect(summary.gapGate).toEqual({ requiredMinutes: 10, passed: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
