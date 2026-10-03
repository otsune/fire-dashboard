// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { prepareOffline } from "../../apps/dashboard/src/data/offline";
function stubServiceWorker(controller: object | null) {
  const waiting = { state: "installed" } as unknown as ServiceWorker;
  const registration = {
    waiting,
    installing: null,
    addEventListener: () => {},
  };
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      controller,
      register: async () => registration,
      ready: Promise.resolve(registration),
    },
    configurable: true,
  });
  return waiting;
}
afterEach(() => {
  vi.unstubAllEnvs();
});
it("does not offer an update for the first install of the offline shell", async () => {
  vi.stubEnv("PROD", true);
  stubServiceWorker(null);
  const onUpdate = vi.fn();
  await prepareOffline(() => {}, onUpdate);
  expect(onUpdate).not.toHaveBeenCalled();
});
it("offers the waiting worker when an older version controls the page", async () => {
  vi.stubEnv("PROD", true);
  const waiting = stubServiceWorker({});
  const onUpdate = vi.fn();
  await prepareOffline(() => {}, onUpdate);
  expect(onUpdate).toHaveBeenCalledWith(waiting);
});
