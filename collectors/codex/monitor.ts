import { readCodexLimits } from "./stdio";
import { captureSnapshot } from "../shared/snapshot";
import type { Usage, UsageEnvelope } from "../../packages/contracts/src/index";
/** Polls only rate limits. It never starts an AI conversation or changes account state. */
export function startCodexCollector(options: {
  path: string;
  sourceAlias: string;
  send: (value: UsageEnvelope) => Promise<void>;
  executable?: string;
  read?: () => Promise<Usage>;
  onError?: (category: "read" | "storage" | "send" | "cleanup") => void;
}) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let value: Usage;
    try {
      value = await (options.read
        ? options.read()
        : readCodexLimits({ executable: options.executable }));
    } catch {
      options.onError?.("read");
      if (!stopped) timer = setTimeout(() => void tick(), 60000);
      return;
    }
    let envelope: UsageEnvelope;
    try {
      envelope = await captureSnapshot(
        value,
        options.path,
        options.sourceAlias,
        { onCleanupError: () => options.onError?.("cleanup") },
      );
    } catch {
      options.onError?.("storage");
      if (!stopped) timer = setTimeout(() => void tick(), 60000);
      return;
    }
    try {
      await options.send(envelope);
    } catch {
      options.onError?.("send");
    }
    if (!stopped) timer = setTimeout(() => void tick(), 60000);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
