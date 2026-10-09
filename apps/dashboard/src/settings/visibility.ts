import type {
  Usage,
  UsageDisplayProvider,
  UsageVisibility,
} from "../../../../packages/contracts/src/index";

export function isUsageConfigured(value: Usage | undefined): boolean {
  return (
    !!value &&
    !(
      value.status === "unconfigured" &&
      !value.sourceAlias &&
      !value.capturedAt &&
      !value.receivedAt &&
      !value.sourceObservedAt &&
      value.buckets.length === 0 &&
      !value.balance
    )
  );
}

export function shouldShowUsage(
  provider: UsageDisplayProvider,
  value: Usage | undefined,
  visibility: UsageVisibility,
): boolean {
  if (!visibility[provider] || provider === "grok") return false;
  if (provider === "claude" || provider === "codex") return true;
  return isUsageConfigured(value);
}
