import {
  usageProviders,
  type Usage,
} from "../../../../packages/contracts/src/index";
import { UsageCard } from "./UsageCard";
const additionalProviders = usageProviders.filter(
  (provider) => provider !== "claude" && provider !== "codex",
);
export function AdditionalUsageCards({
  usage,
  timeZone,
  now,
}: {
  usage: Usage[];
  timeZone: string;
  now: number;
}) {
  return additionalProviders.flatMap((provider) => {
    const value = usage.find((entry) => entry.provider === provider);
    if (
      !value ||
      (value.status === "unconfigured" &&
        !value.sourceAlias &&
        !value.capturedAt &&
        !value.receivedAt &&
        !value.sourceObservedAt &&
        value.buckets.length === 0 &&
        !value.balance)
    )
      return [];
    return [
      <UsageCard key={provider} value={value} timeZone={timeZone} now={now} />,
    ];
  });
}
