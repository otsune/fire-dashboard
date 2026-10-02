let held: WakeLockSentinel | null = null;
export async function requestWakeLock(
  onRelease?: () => void,
): Promise<"held" | "unsupported" | "denied"> {
  if (!("wakeLock" in navigator)) return "unsupported";
  try {
    held = await navigator.wakeLock.request("screen");
    held.addEventListener(
      "release",
      () => {
        held = null;
        onRelease?.();
      },
      { once: true },
    );
    return "held";
  } catch {
    return "denied";
  }
}
export async function releaseWakeLock() {
  await held?.release();
  held = null;
}
