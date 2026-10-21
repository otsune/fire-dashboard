/** Non-overlapping polling measured from the start of each observation. */
export function startPollLoop(
  task: (active: () => boolean) => Promise<void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !stopped;
  const tick = async () => {
    const start = Date.now();
    try {
      await task(active);
    } finally {
      if (!stopped) {
        const elapsed = Date.now() - start;
        // Skip a missed deadline rather than producing a burst of catch-up reads.
        const delay =
          elapsed < intervalMs ? intervalMs - Math.max(0, elapsed) : intervalMs;
        timer = setTimeout(() => void tick(), delay);
      }
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
