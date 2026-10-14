#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const usage = () => {
  process.stderr.write(
    "Usage: node scripts/validate-mqtt-observations.mjs --claude <path> --fire <path> --host <path> [--min-hours <hours>] [--max-gap-minutes <minutes>]\n",
  );
};

function parseArgs(argv) {
  const paths = {};
  const options = { minHours: null, maxGapMinutes: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (
      ![
        "--claude",
        "--fire",
        "--host",
        "--min-hours",
        "--max-gap-minutes",
      ].includes(key)
    ) {
      throw new Error(`unknown_option:${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing_value:${key}`);
    if (key === "--min-hours" || key === "--max-gap-minutes") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw new Error(`invalid_number:${key}`);
      }
      options[key === "--min-hours" ? "minHours" : "maxGapMinutes"] = numeric;
    } else {
      paths[key.slice(2)] = value;
    }
    index += 1;
  }
  if (Object.keys(paths).length !== 3) throw new Error("three_logs_required");
  return { paths, options };
}

async function readLog(path) {
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const parsed = [];
  const parseErrors = [];
  for (const [index, line] of lines.entries()) {
    try {
      parsed.push({ line: index + 1, value: JSON.parse(line) });
    } catch {
      parseErrors.push(index + 1);
    }
  }
  return { lines: lines.length, parsed, parseErrors };
}

function timeRange(values) {
  const timestamps = values
    .map((value) => Date.parse(value.observedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const firstMs = timestamps[0] ?? null;
  const lastMs = timestamps.at(-1) ?? null;
  const gaps = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]);
  return {
    first: values[0]?.observedAt ?? null,
    last: values.at(-1)?.observedAt ?? null,
    durationHours:
      firstMs === null || lastMs === null
        ? null
        : Math.round(((lastMs - firstMs) / 3_600_000) * 1000) / 1000,
    maxGapMinutes:
      gaps.length === 0
        ? timestamps.length === 0
          ? null
          : 0
        : Math.round((Math.max(...gaps) / 60_000) * 1000) / 1000,
  };
}

function checkClaude(log) {
  const accepted = [];
  const failures = [];
  for (const row of log.parsed) {
    const value = row.value;
    const runtime = value.mqttStatus?.runtime;
    const ok =
      !value.error &&
      runtime?.state === "connected" &&
      runtime?.deliveryStatus === "ok" &&
      value.health?.status === "ok" &&
      value.mqttFooter === true &&
      value.claude?.status === "ok" &&
      value.claude?.sourceAlias === "gmktec";
    if (ok) accepted.push(value);
    else failures.push(row.line);
  }
  return {
    rows: log.lines,
    parseErrors: log.parseErrors,
    accepted: accepted.length,
    failures,
    reconnectCountMax: Math.max(
      0,
      ...accepted.map((value) => value.mqttStatus.runtime.reconnectCount ?? 0),
    ),
    ...timeRange(accepted),
  };
}

function checkFire(log) {
  const accepted = [];
  const ignored = [];
  const failures = [];
  for (const row of log.parsed) {
    const value = row.value;
    if (
      !value.mqttStatus &&
      !value.error &&
      typeof value.pageUrl === "string"
    ) {
      ignored.push(row.line);
      continue;
    }
    const runtime = value.mqttStatus?.runtime;
    const ok =
      !value.error &&
      runtime?.state === "connected" &&
      runtime?.deliveryStatus === "ok" &&
      value.health?.status === "ok" &&
      value.mqttFooter === true;
    if (ok) accepted.push(value);
    else failures.push(row.line);
  }
  return {
    rows: log.lines,
    parseErrors: log.parseErrors,
    accepted: accepted.length,
    ignored,
    failures,
    reconnectCountMax: Math.max(
      0,
      ...accepted.map((value) => value.mqttStatus.runtime.reconnectCount ?? 0),
    ),
    ...timeRange(accepted),
  };
}

function checkHost(log) {
  const accepted = [];
  const failures = [];
  for (const row of log.parsed) {
    const value = row.value;
    const interfaces = Object.values(value.netdev ?? {});
    const hasTraffic = interfaces.some(
      (network) => network.rxBytes > 0 && network.txBytes > 0,
    );
    const ok =
      !value.error &&
      value.api?.ActiveState === "active" &&
      value.api?.SubState === "running" &&
      value.api?.NRestarts === "0" &&
      value.claudeSender?.ActiveState === "active" &&
      value.claudeSender?.SubState === "running" &&
      value.claudeSender?.NRestarts === "0" &&
      value.claudeSnapshot?.provider === "claude" &&
      value.claudeSnapshot?.sourceAlias === "gmktec" &&
      hasTraffic;
    if (ok) accepted.push(value);
    else failures.push(row.line);
  }
  return {
    rows: log.lines,
    parseErrors: log.parseErrors,
    accepted: accepted.length,
    failures,
    ...timeRange(accepted),
  };
}

function hasFailure(summary) {
  return (
    summary.parseErrors.length > 0 ||
    summary.failures.length > 0 ||
    summary.accepted === 0
  );
}

function gate(summary, key, required, compare) {
  if (required === null) return true;
  return summary.every(
    (value) => value[key] !== null && compare(value[key], required),
  );
}

try {
  const { paths, options } = parseArgs(process.argv.slice(2));
  const logs = {
    claude: await readLog(paths.claude),
    fire: await readLog(paths.fire),
    host: await readLog(paths.host),
  };
  const summary = {
    claude: checkClaude(logs.claude),
    fire: checkFire(logs.fire),
    host: checkHost(logs.host),
  };
  const logSummaries = Object.values(summary);
  summary.durationGate =
    options.minHours === null
      ? null
      : {
          requiredHours: options.minHours,
          passed: gate(
            logSummaries,
            "durationHours",
            options.minHours,
            (actual, required) => actual >= required,
          ),
        };
  summary.gapGate =
    options.maxGapMinutes === null
      ? null
      : {
          requiredMinutes: options.maxGapMinutes,
          passed: gate(
            logSummaries,
            "maxGapMinutes",
            options.maxGapMinutes,
            (actual, required) => actual <= required,
          ),
        };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (
    logSummaries.some(hasFailure) ||
    summary.durationGate?.passed === false ||
    summary.gapGate?.passed === false
  ) {
    process.exitCode = 1;
  }
} catch (error) {
  usage();
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
