import type { UsageProvider } from "../../../../packages/contracts/src/index";
export const providerPresentation: Record<
  UsageProvider,
  { name: string; icon: string }
> = {
  claude: { name: "Claude", icon: "✳" },
  codex: { name: "Codex", icon: "›_" },
  antigravity: { name: "Antigravity", icon: "AG" },
  opencode_go: { name: "OpenCode Go", icon: "OC" },
  hermes_nous: { name: "Hermes / Nous", icon: "H" },
};
