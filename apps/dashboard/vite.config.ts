import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeBundledAudio } from "../../scripts/finalize-bundled-audio";
const dist = fileURLToPath(new URL("./dist", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), {
    name: "bundled-hourly-ogg",
    apply: "build",
    // Resolved outputDir also supports callers choosing another build destination.
    configResolved(config) { thisDist = resolve(config.root, config.build.outDir); },
    async closeBundle() { await finalizeBundledAudio(thisDist); },
  }],
  build: { target: "es2020" },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
let thisDist = dist;
