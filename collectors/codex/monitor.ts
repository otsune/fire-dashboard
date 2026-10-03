import { readCodexLimits } from "./stdio";
import { captureSnapshot } from "../shared/snapshot";
import type { Usage, UsageEnvelope } from "../../packages/contracts/src/index";
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
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let value: Usage;
    try {
      value = await (options.read ?? readCodexLimits)();
    } catch {
      options.onError?.("read");
      if (!stopped) timer = setTimeout(() => void tick(), interval);
      return;
    }
    let envelope: UsageEnvelope;
    try {
      envelope = await captureSnapshot(
        value,
        options.path,
        options.sourceAlias,
      );
    } catch {
      options.onError?.("storage");
      if (!stopped) timer = setTimeout(() => void tick(), interval);
      return;
    }
    try {
      await options.send(envelope);
    } catch {
      options.onError?.("send");
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
