export async function prepareOffline(
  onStatus: (status: string) => void,
  onUpdate: (worker: ServiceWorker) => void,
) {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) {
    onStatus("この配信元ではオフライン未対応");
    return;
  }
  if (!import.meta.env.PROD) {
    onStatus("開発プレビュー");
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const waiting = () => {
      if (registration.waiting) onUpdate(registration.waiting);
    };
    waiting();
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") {
          waiting();
          if (!navigator.serviceWorker.controller)
            onStatus("オフライン準備完了");
        }
      });
    });
    await navigator.serviceWorker.ready;
    onStatus("オフライン準備完了");
  } catch {
    onStatus("オフライン資産を保存できません");
  }
}
