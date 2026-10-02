import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCodexLimits,
  validateCodexExecutable,
} from "../../collectors/codex/stdio";
import { startCodexCollector } from "../../collectors/codex/monitor";
import type { UsageEnvelope } from "../../packages/contracts/src/index";

// An actual executable exchanges JSON-RPC over pipes; no spawn mock can hide a
// regression to PATH lookup, shell interpretation, or altered argument lists.
describe.skipIf(process.platform === "win32")(
  "configured Codex process",
  () => {
    let directory: string;
    let executable: string;
    let calls: string;
    let decoyCalls: string;

    async function fakeServer(path: string, log: string) {
      await writeFile(
        path,
        `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const record = (value) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + "\\n");
record({ args: process.argv.slice(2) });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  record({ method: request.method });
  if (request.id === 0) process.stdout.write(JSON.stringify({ id: 0, result: {} }) + "\\n");
  if (request.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { rateLimits: { primary: { usedPercent: 27 } } } }) + "\\n");
});
`,
        { mode: 0o700 },
      );
    }

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "fire codex-"));
      executable = join(directory, "trusted codex;literal");
      calls = join(directory, "trusted.jsonl");
      decoyCalls = join(directory, "decoy.jsonl");
      await fakeServer(executable, calls);
      await fakeServer(join(directory, "codex"), decoyCalls);
      vi.stubEnv("PATH", directory);
      vi.stubEnv("FIRE_CODEX_EXECUTABLE", undefined);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    });

    it("rejects missing configuration without executing a codex found on PATH", async () => {
      await expect(readCodexLimits()).rejects.toThrow(/FIRE_CODEX_EXECUTABLE/);
      await expect(readFile(decoyCalls)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it.each(["", "codex", "./codex", "../codex"])(
      "rejects nonabsolute configuration %j without PATH fallback",
      async (configured) => {
        vi.stubEnv("FIRE_CODEX_EXECUTABLE", configured);
        await expect(readCodexLimits()).rejects.toThrow(/absolute/);
        await expect(readFile(decoyCalls)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it("uses the exact environment path and fixed app-server argument without a shell", async () => {
      vi.stubEnv("FIRE_CODEX_EXECUTABLE", executable);
      const usage = await readCodexLimits();
      expect(usage.buckets[0].windows[0].usedPercent).toBe(27);
      expect(
        (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { args: ["app-server"] },
        { method: "initialize" },
        { method: "initialized" },
        { method: "account/rateLimits/read" },
      ]);
      await expect(readFile(decoyCalls)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("lets an explicit executable override the environment", async () => {
      vi.stubEnv("FIRE_CODEX_EXECUTABLE", "untrusted-relative-path");
      const usage = await readCodexLimits({ executable });
      expect(usage.status).toBe("ok");
      await expect(readFile(decoyCalls)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("does not replace an invalid explicit executable with the environment", async () => {
      vi.stubEnv("FIRE_CODEX_EXECUTABLE", executable);
      await expect(readCodexLimits({ executable: "" })).rejects.toThrow(
        /absolute/,
      );
      await expect(readFile(calls)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(decoyCalls)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("does not fall back to PATH when an absolute executable is missing", async () => {
      vi.stubEnv("FIRE_CODEX_EXECUTABLE", join(directory, "missing"));
      expect((await readCodexLimits()).errorCode).toBe("network");
      await expect(readFile(decoyCalls)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("passes the collector executable option to its real stdio reader", async () => {
      let resolve!: (value: UsageEnvelope) => void;
      let reject!: (reason: Error) => void;
      const outcome = new Promise<UsageEnvelope>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const stop = startCodexCollector({
        executable,
        path: join(directory, "snapshot.json"),
        sourceAlias: "pc",
        send: async (envelope) => resolve(envelope),
        onError: (category) => reject(new Error(category)),
      });
      try {
        const envelope = await outcome;
        expect(envelope.payload.buckets[0].windows[0].usedPercent).toBe(27);
        await expect(readFile(calls, "utf8")).resolves.toContain(
          '"args":["app-server"]',
        );
        await expect(readFile(decoyCalls)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        stop();
      }
    });

    it("reports invalid collector configuration as a read error without sending", async () => {
      let resolve!: (value: string) => void;
      const outcome = new Promise<string>((res) => {
        resolve = res;
      });
      const send = vi.fn(async () => {
        resolve("send");
      });
      const stop = startCodexCollector({
        executable: "codex",
        path: join(directory, "snapshot.json"),
        sourceAlias: "pc",
        send,
        onError: (category) => resolve(category),
      });
      try {
        expect(await outcome).toBe("read");
        expect(send).not.toHaveBeenCalled();
        await expect(readFile(decoyCalls)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        stop();
      }
    });
  },
);

describe("Codex executable path validation", () => {
  it.each([undefined, "", "codex", "./codex", "../codex", "C:\\codex.exe"])(
    "rejects a nonabsolute POSIX path %j",
    (path) =>
      expect(() => validateCodexExecutable(path, "linux")).toThrow(/absolute/),
  );

  it("preserves an absolute POSIX executable literally", () => {
    const executable = "/opt/trusted codex;literal";
    expect(validateCodexExecutable(executable, "linux")).toBe(executable);
  });

  it.each([
    undefined,
    "",
    "codex.exe",
    "C:codex.exe",
    "\\codex.exe",
    "/codex.exe",
    "./codex.exe",
  ])(
    "rejects a Windows path dependent on PATH or the current drive: %j",
    (path) =>
      expect(() => validateCodexExecutable(path, "win32")).toThrow(/absolute/),
  );

  it.each([
    "C:\\Program Files\\Codex\\codex.exe",
    "C:/Codex/codex.exe",
    "\\\\server\\share\\codex.exe",
  ])("accepts a fully qualified Windows executable %j", (path) =>
    expect(validateCodexExecutable(path, "win32")).toBe(path),
  );

  it.each([
    "C:\\Codex\\codex.cmd",
    "C:\\Codex\\codex.BAT",
    "C:/Codex/codex.CmD",
    "C:\\Codex\\codex.cmd. ",
  ])("rejects Windows shell shim %j", (path) =>
    expect(() => validateCodexExecutable(path, "win32")).toThrow(
      /cmd|bat|shell/i,
    ),
  );

  it("rejects a NUL in the executable path before spawning", () => {
    expect(() =>
      validateCodexExecutable("/opt/codex\u0000", "linux"),
    ).toThrow();
  });
});
