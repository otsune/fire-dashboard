export function nextDelay(
  attempt: number,
  baseMs: number,
  random: () => number = Math.random,
  retryAfterMs?: number | null,
): number {
  if (retryAfterMs !== undefined && retryAfterMs !== null && retryAfterMs > 0)
    return Math.min(retryAfterMs, 2147483647);
  const delays = [60000, 300000, 900000, 1800000];
  const delay =
    attempt === 0 ? baseMs : delays[Math.min(Math.max(0, attempt - 1), 3)];
  return Math.round(delay * (1 + Math.max(0, Math.min(1, random())) * 0.1));
}
export function createSingleFlight<T>(
  work: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending)
      pending = work().finally(() => {
        pending = null;
      });
    return pending;
  };
}
export function startSchedule(
  work: () => Promise<{ ok: boolean; retryAfterMs?: number | null }>,
  baseMs: number,
) {
  let attempt = 0,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const run = createSingleFlight(async () => {
    let result: { ok: boolean; retryAfterMs?: number | null };
    try {
      result = await work();
    } catch {
      result = { ok: false };
    }
    attempt = result.ok ? 0 : attempt + 1;
    if (!stopped)
      timer = setTimeout(
        () => void run(),
        nextDelay(attempt, baseMs, Math.random, result.retryAfterMs),
      );
  });
  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
