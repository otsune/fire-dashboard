/** A wall clock is not proof that another tab has stopped. Web Locks, when
 * available, provide live-process exclusion and release automatically on crash.
 * Without them the IndexedDB record is only released by its verified owner. */
export async function withBrowserAudioLock(
  work: (exclusive: boolean) => Promise<boolean>,
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(
      "fire-dashboard-audio-v1",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => (lock ? work(true) : false),
    );
  }
  return work(false);
}
