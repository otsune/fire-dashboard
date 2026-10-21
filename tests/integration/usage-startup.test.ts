import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { usageDeliverySchema } from "../../packages/usage-contracts/src/index";

it("starts the bundled usage API outside the repo and persists initial state before advertising readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-startup-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const entry = join(dir, "start.mjs");
    await build({
      entryPoints: ["services/usage/src/start.ts"],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    const auth = join(dir, "auth.mjs"),
      config = join(dir, "config.json"),
      state = join(dir, "state.json");
    await writeFile(
      auth,
      'export const authorize = async () => true; export const sourceAlias = async () => "desk";',
    );
    await writeFile(config, "{}");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("FIRE_") && !key.startsWith("USAGE_"),
      ),
    );
    // Ask the OS for a free loopback port, then close the reservation before launching.
    const net = await import("node:net");
    const reserve = net.createServer();
    await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
    const port = (reserve.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r, j) => reserve.close((e) => (e ? j(e) : r())));
    child = spawn(process.execPath, [entry], {
      cwd: dir,
      env: {
        ...env,
        USAGE_AUTH_MODULE: auth,
        USAGE_CONFIG: config,
        USAGE_STATE_FILE: state,
        USAGE_PUBLIC_ORIGIN: "https://display.example",
        USAGE_PORT: String(port),
      },
    });
    const running = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("startup_timeout")), 10000);
      let output = "";
      running.stdout!.on("data", (chunk) => {
        output += chunk;
        if (output.includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      running.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`startup_exit_${code}`));
      });
    });
    const saved = JSON.parse(await readFile(state, "utf8"));
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/usage`);
    expect(response.status).toBe(200);
    expect(usageDeliverySchema.parse(await response.json())).toEqual(
      saved.delivery,
    );
    expect(saved.delivery.revision).toBe("0");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
