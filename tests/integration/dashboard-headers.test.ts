import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer, preview } from "vite";

const configFile = fileURLToPath(
  new URL("../../apps/dashboard/vite.config.ts", import.meta.url),
);

describe.each(["dev", "preview"] as const)(
  "dashboard %s HTTP headers",
  (mode) => {
    let server: Awaited<ReturnType<typeof createServer | typeof preview>>;
    let outputDirectory: string | undefined;
    let origin: string;

    beforeAll(async () => {
      const listener = { host: "127.0.0.1", port: 0, strictPort: false };
      if (mode === "dev") {
        server = await createServer({
          configFile,
          logLevel: "error",
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { ...listener, watch: null, hmr: false },
        });
        await server.listen();
      } else {
        outputDirectory = await mkdtemp(
          join(tmpdir(), "fire-dashboard-headers-"),
        );
        await build({
          configFile,
          logLevel: "error",
          build: { outDir: outputDirectory },
        });
        server = await preview({
          configFile,
          logLevel: "error",
          build: { outDir: outputDirectory },
          preview: listener,
        });
      }
      const address = server.httpServer?.address();
      if (!address || typeof address === "string")
        throw Error("missing_listener");
      origin = `http://127.0.0.1:${address.port}`;
    }, 30_000);

    afterAll(async () => {
      await server?.close();
      if (outputDirectory)
        await rm(outputDirectory, { recursive: true, force: true });
    });

    it("preserves the frame-protection rollout marker in the offline shell HTML", async () => {
      const response = await fetch(new URL("/index.html", origin));
      // build-sw hashes the built HTML, so this marker must survive the build
      // to retire previously cached HTML responses that lack framing headers.
      expect(await response.text()).toContain(
        "<!-- frame-ancestors requires HTTP response headers; see docs/deployment.md. -->",
      );
    });

    it.each(["/", "/nested/dashboard/route"])(
      "blocks framing through response headers for %s",
      async (path) => {
        const response = await fetch(new URL(path, origin), {
          headers: { accept: "text/html" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("content-security-policy") ?? "").toMatch(
          /(?:^|;\s*)frame-ancestors 'none'(?:;|$)/,
        );
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        // Header protection supplements the existing resource restrictions.
        const html = await response.text();
        expect(html).toContain('http-equiv="Content-Security-Policy"');
        for (const directive of [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "img-src 'self' data:",
          "media-src 'self'",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ]) {
          expect(html).toContain(directive);
        }
      },
    );
  },
);
