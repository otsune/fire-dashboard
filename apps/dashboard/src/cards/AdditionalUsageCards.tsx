import {
  usageProviders,
  defaultUsageVisibility,
  type Usage,
  type UsageVisibility,
} from "../../../../packages/contracts/src/index";
import { UsageCard } from "./UsageCard";
import { shouldShowUsage } from "../settings/visibility";
const additionalProviders = usageProviders.filter(
  (provider) => provider !== "claude" && provider !== "codex",
);
export function AdditionalUsageCards({
  usage,
  timeZone,
  now,
  visibility = defaultUsageVisibility,
}: {
  usage: Usage[];
  timeZone: string;
  now: number;
  visibility?: UsageVisibility;
}) {
  return additionalProviders.flatMap((provider) => {
    const value = usage.find((entry) => entry.provider === provider);
    if (!value || !shouldShowUsage(provider, value, visibility)) return [];
    return [
      <UsageCard key={provider} value={value} timeZone={timeZone} now={now} />,
    ];
  });
}
