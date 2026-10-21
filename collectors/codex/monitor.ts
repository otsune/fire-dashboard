import { startPollLoop } from "../shared/poll";
import { readCodexLimits } from "./stdio";
import { captureSnapshot } from "../shared/snapshot";
import type {
  Usage,
  UsageEnvelope,
} from "../../packages/usage-contracts/src/index";
/** Polls only rate limits. It never starts an AI conversation or changes account state. */
export function startCodexCollector(options: {
  path: string;
  sourceAlias: string;
  send: (value: UsageEnvelope) => Promise<void>;
  read?: () => Promise<Usage>;
  onError?: (category: "read" | "storage" | "send") => void;
  /** Each read starts a `codex app-server` process; keep this as long as the display allows. */
  intervalMs?: number;
}) {
  const interval = options.intervalMs ?? 60000;
  return startPollLoop(async (active) => {
    let value: Usage;
    try {
      value = await (options.read ?? readCodexLimits)();
    } catch {
      options.onError?.("read");
      return;
    }
    if (!active()) return;
    let envelope: UsageEnvelope;
    try {
      envelope = await captureSnapshot(
        value,
        options.path,
        options.sourceAlias,
      );
    } catch {
      options.onError?.("storage");
      return;
    }
    if (!active()) return;
    try {
      await options.send(envelope);
    } catch {
      options.onError?.("send");
    }
  }, interval);
}
