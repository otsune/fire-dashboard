import type { UsageProvider } from "./index";

export type UsageDisplayProvider = UsageProvider | "grok";
export type UsageVisibility = Record<UsageDisplayProvider, boolean>;

export const defaultUsageVisibility: UsageVisibility = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode_go: true,
  hermes_nous: true,
  grok: true,
};

export function readUsageVisibility(input: unknown): {
  value: UsageVisibility;
  warnings: string[];
} {
  const value = { ...defaultUsageVisibility };
  const warnings: string[] = [];
  if (input === undefined) return { value, warnings };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    warnings.push("設定「usageVisibility」を初期値に戻しました");
    return { value, warnings };
  }
  const source = input as Record<string, unknown>;
  for (const provider of Object.keys(value) as UsageDisplayProvider[]) {
    if (!Object.prototype.hasOwnProperty.call(source, provider)) continue;
    if (typeof source[provider] === "boolean")
      value[provider] = source[provider];
    else
      warnings.push(`設定「usageVisibility.${provider}」を初期値に戻しました`);
  }
  return { value, warnings };
}
