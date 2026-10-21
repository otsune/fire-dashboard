// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/dashboard/src/App";
import { emptyDashboard } from "../../packages/contracts/src/index";
import { usageEnvelope } from "../helpers/usage";
import { loadDashboard } from "../../apps/dashboard/src/data/cache";

const client = vi.hoisted(() => ({
  connected: true,
  handlers: new Map<string, Array<(...args: any[]) => void>>(),
  on(event: string, fn: (...args: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  },
  subscribe() {},
  end() {
    this.handlers.clear();
  },
}));
vi.mock("mqtt", () => ({
  default: { connect: () => client },
  connect: () => client,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  client.handlers.clear();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("keeps MQTT alive when an unavailable usage backend has not supplied its first snapshot", async () => {
  window.history.replaceState({}, "", "/?usageMqtt=1");
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(
      url.includes("manifest")
        ? { hours: {}, chime: null }
        : { ...emptyDashboard(), usageConnection: "unavailable" },
    ),
  );
  render(<App />);
  await screen.findByText("usage提供サービスに未接続 · 最後の値を表示");
  await waitFor(() =>
    expect(screen.getByText(/MQTT 接続済み/)).toBeInTheDocument(),
  );
  await act(async () => {
    const delivery = {
      schemaVersion: 1,
      streamId: "recovered",
      revision: "1",
      publishedAt: new Date().toISOString(),
      usage: [usageEnvelope(1).payload],
    };
    for (const fn of client.handlers.get("message") ?? [])
      fn("fire-dashboard/v1/main/usage/state", JSON.stringify(delivery));
  });
  await waitFor(() =>
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute(
      "value",
      "30",
    ),
  );
});

it("resumes MQTT after a legacy metadata-free HTTP response and uses its current values", async () => {
  window.history.replaceState({}, "", "/?usageMqtt=1");
  let legacy = true;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.includes("manifest"))
      return Response.json({ hours: {}, chime: null });
    return Response.json({
      ...emptyDashboard(),
      usage: [usageEnvelope(1, "desk", 40).payload],
      ...(legacy
        ? {}
        : {
            usageDelivery: {
              schemaVersion: 1,
              streamId: "new",
              revision: "1",
              publishedAt: new Date().toISOString(),
            },
          }),
    });
  });
  render(<App />);
  await screen.findByText("集約サービス接続済み");
  await waitFor(() =>
    expect(screen.getAllByRole("progressbar")[0]).toHaveAttribute(
      "value",
      "40",
    ),
  );
  await waitFor(async () =>
    expect(
      (await loadDashboard())?.usage[0].buckets[0].windows[0].usedPercent,
    ).toBe(40),
  );
  legacy = false;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() =>
    expect(screen.getByText(/MQTT 接続済み/)).toBeInTheDocument(),
  );
});
