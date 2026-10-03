// Bundles collector entry points into single ESM files that start with plain
// `node`. The statusline runs on every Claude Code redraw, so it must not pay
// for a TypeScript loader at startup (npx tsx takes over a second on Windows).
import { build } from "esbuild";
const entries = {
  "claude-statusline": "collectors/claude/statusline.ts",
  "codex-service": "collectors/codex/service.ts",
  "send-snapshot": "collectors/shared/send-service.ts",
};
await build({
  entryPoints: entries,
  outdir: "dist/collectors",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
console.log(`Collectors: ${Object.keys(entries).join(", ")} -> dist/collectors`);
