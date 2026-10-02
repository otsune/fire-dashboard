import { useEffect, useState } from "react";
import type { createAudioController } from "./controller";
export function AudioControls({
  controller,
}: {
  controller: ReturnType<typeof createAudioController> | null;
}) {
  const [state, setState] = useState(controller?.state());
  useEffect(() => {
    setState(controller?.state());
    const id = setInterval(() => setState(controller?.state()), 500);
    return () => clearInterval(id);
  }, [controller]);
  return (
    <div className="audio-controls">
      <span className="audio-label">
        ♪ <span>{state?.message ?? "音源未設定"}</span>
      </span>
      <button
        disabled={!state?.ready}
        onClick={async () => {
          if (state?.enabled) controller?.disable();
          else await controller?.enable();
          setState(controller?.state());
        }}
      >
        {state?.enabled ? "音声を無効にする" : "音声を有効にする"}
      </button>
      <button
        disabled={!state?.ready}
        onClick={() => void controller?.preview(10)}
      >
        試聴
      </button>
    </div>
  );
}
