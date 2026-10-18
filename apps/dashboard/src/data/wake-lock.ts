let held: WakeLockSentinel | null = null;
export async function requestWakeLock(
  onRelease?: () => void,
): Promise<"held" | "unsupported" | "denied"> {
  if (!("wakeLock" in navigator)) return "unsupported";
  try {
    // A later request replaces an older sentinel; each release listener must
    // only clear the reference while it still belongs to the newest lock.
    const lock = await navigator.wakeLock.request("screen");
    lock.addEventListener(
      "release",
      () => {
        if (held === lock) {
          held = null;
          onRelease?.();
        }
      },
      { once: true },
    );
    held = lock;
    return "held";
  } catch {
    return "denied";
  }
}
export async function releaseWakeLock() {
  await held?.release();
  held = null;
}
