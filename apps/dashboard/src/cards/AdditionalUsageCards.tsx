import {
  emptyUsage,
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
  return additionalProviders.map((provider) => (
    <UsageCard
      key={provider}
      value={
        usage.find((value) => value.provider === provider) ??
        emptyUsage(provider)
      }
      timeZone={timeZone}
      now={now}
    />
  ));
}
