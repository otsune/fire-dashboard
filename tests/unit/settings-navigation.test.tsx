// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  useSettingsNavigation,
  type SettingsGuard,
} from "../../apps/dashboard/src/settings/navigation";

const clean: SettingsGuard = { dirty: false, saving: false };

// Resolve each queued delta at execution time. jsdom's native history computes
// rapid Back targets before applying them, which misses sequential traversal.
function queuedHistory() {
  let entries: unknown[] = [{ dashboard: "older" }, { dashboard: true }];
  let index = 1;
  const deltas: number[] = [];
  const positions: number[] = [];
  const history = {
    get state() {
      return entries[index];
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown) {
      entries = entries.slice(0, index + 1);
      entries.push(structuredClone(state));
      index++;
    },
    replaceState(state: unknown) {
      entries[index] = structuredClone(state);
    },
    back() {
      deltas.push(-1);
    },
    forward() {
      deltas.push(1);
    },
    go(delta: number) {
      deltas.push(delta);
    },
  };
  vi.spyOn(window, "history", "get").mockReturnValue(
    history as unknown as History,
  );
  const flushOne = () => {
    const delta = deltas.shift();
    if (delta === undefined) return;
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    index = target;
    positions.push(index);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: structuredClone(entries[index]) }),
    );
  };
  const flushAll = () => {
    let remaining = 20;
    while (deltas.length) {
      if (!remaining--) throw new Error("History traversal did not converge");
      flushOne();
    }
  };
  return { history, flushOne, flushAll, positions, index: () => index };
}

beforeEach(() =>
  window.history.replaceState(
    { dashboard: true },
    "",
    "/dashboard?mode=kiosk#clock",
  ),
);
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
});

describe("unified settings navigation", () => {
  it("adopts Forward after a closed remount without extra history or a later unexpected reopen", () => {
    const model = queuedHistory();
    const url = window.location.href;
    function Harness() {
      const navigation = useSettingsNavigation(clean);
      return (
        <>
          <button
            id="usage-opener"
            onClick={() => navigation.open("usage", "usage-opener")}
          >
            Usageを開く
          </button>
          <button
            id="audio-opener"
            onClick={() => navigation.open("clock_audio", "audio-opener")}
          >
            Audioを開く
          </button>
          {navigation.section && (
            <>
              <h1 id={`settings-heading-${navigation.section}`} tabIndex={-1}>
                {navigation.section}
              </h1>
              <button onClick={navigation.close}>閉じる</button>
            </>
          )}
        </>
      );
    }
    let app = render(<Harness />);
    fireEvent.click(screen.getByText("Usageを開く"));
    const marker = model.history.state as {
      fireDashboardSettings: { id: string; section: string; openerId: string };
    };
    fireEvent.click(screen.getByText("閉じる"));
    act(model.flushAll);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Usageを開く")).toHaveFocus();
    expect(model.index()).toBe(1);
    app.unmount();

    app = render(<Harness />);
    expect(screen.queryByRole("heading")).toBeNull();
    act(() => {
      window.history.forward();
      model.flushAll();
    });
    expect(screen.getByRole("heading", { name: "usage" })).toHaveFocus();
    expect(model.history.state).toEqual(marker);
    expect(model.index()).toBe(2);
    expect(model.history.length).toBe(3);
    fireEvent.click(screen.getByText("閉じる"));
    act(model.flushAll);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Usageを開く")).toHaveFocus();
    act(() => {
      window.history.forward();
      model.flushAll();
    });
    expect(screen.getByRole("heading", { name: "usage" })).toHaveFocus();

    fireEvent.click(screen.getByText("Audioを開く"));
    expect(screen.getByRole("heading", { name: "clock_audio" })).toHaveFocus();
    expect(model.history.state).toEqual({
      ...marker,
      fireDashboardSettings: {
        ...marker.fireDashboardSettings,
        section: "clock_audio",
      },
    });
    fireEvent.click(screen.getByText("閉じる"));
    act(model.flushAll);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Usageを開く")).toHaveFocus();
    expect(model.history.state).toEqual({ dashboard: true });
    expect(model.index()).toBe(1);
    expect(model.history.length).toBe(3);
    app.unmount();

    app = render(<Harness />);
    expect(screen.queryByRole("heading")).toBeNull();
    fireEvent.click(screen.getByText("Audioを開く"));
    fireEvent.click(screen.getByText("閉じる"));
    act(model.flushAll);
    expect(screen.getByText("Audioを開く")).toHaveFocus();
    expect(model.history.state).toEqual({ dashboard: true });
    expect(model.history.length).toBe(3);
    app.unmount();
    render(<Harness />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(window.location.href).toBe(url);
  });

  it.each(["dirty", "saving"] as const)(
    "does not adopt another valid entry while the active section is %s",
    (mode) => {
      const model = queuedHistory();
      const { result, rerender } = renderHook(
        (guard: SettingsGuard) => useSettingsNavigation(guard),
        { initialProps: clean },
      );
      model.history.replaceState({
        fireDashboardSettings: {
          id: "another-instance",
          section: "usage",
          openerId: "other-opener",
        },
      });
      act(() => result.current.open("weather", "opener"));
      const marker = model.history.state;
      rerender({ dirty: mode === "dirty", saving: mode === "saving" });
      act(() => {
        window.history.back();
        model.flushAll();
      });
      expect(model.history.state).toEqual(marker);
      expect(result.current.section).toBe("weather");
      expect(result.current.pending).toBe(mode === "dirty" ? "close" : null);
      expect(model.history.length).toBe(3);
    },
  );

  it.each([
    ["dirty", "two Back deltas"],
    ["saving", "two Back deltas"],
    ["dirty", "go(-2)"],
    ["saving", "go(-2)"],
  ] as const)(
    "converges to the settings marker after %s %s and remains usable",
    (mode, traversal) => {
      const model = queuedHistory();
      const url = window.location.href;
      const { result, rerender } = renderHook(
        (guard: SettingsGuard) => useSettingsNavigation(guard),
        { initialProps: clean },
      );
      act(() => result.current.open("weather", "opener"));
      const marker = model.history.state;
      rerender({ dirty: mode === "dirty", saving: mode === "saving" });
      act(() => {
        if (traversal === "go(-2)") window.history.go(-2);
        else {
          window.history.back();
          window.history.back();
        }
        model.flushAll();
      });
      expect(model.history.state).toEqual(marker);
      expect(model.index()).toBe(2);
      expect(model.history.length).toBe(3);
      expect(result.current.section).toBe("weather");
      expect(result.current.pending).toBe(mode === "dirty" ? "close" : null);
      if (mode === "dirty") act(() => result.current.keepEditing());
      rerender(clean);
      act(() => result.current.select("rss"));
      expect(result.current.section).toBe("rss");
      act(() => {
        result.current.close();
        model.flushAll();
      });
      expect(result.current.section).toBeNull();
      expect(model.index()).toBe(1);
      act(() => {
        window.history.forward();
        model.flushAll();
      });
      expect(result.current.section).toBe("rss");
      expect(model.index()).toBe(2);
      expect(model.history.length).toBe(3);
      expect(window.location.href).toBe(url);
    },
  );

  it.each(["dirty", "saving"] as const)(
    "finishes %s restoration even if its guard becomes clean between queued deltas",
    (mode) => {
      const model = queuedHistory();
      const { result, rerender } = renderHook(
        (guard: SettingsGuard) => useSettingsNavigation(guard),
        { initialProps: clean },
      );
      act(() => result.current.open("weather", "opener"));
      const marker = model.history.state;
      rerender({ dirty: mode === "dirty", saving: mode === "saving" });
      act(() => {
        window.history.back();
        window.history.back();
        model.flushOne();
      });
      if (mode === "dirty") act(() => result.current.keepEditing());
      rerender(clean);
      act(model.flushAll);
      expect(model.history.state).toEqual(marker);
      expect(result.current.section).toBe("weather");
      expect(result.current.pending).toBeNull();
      act(() => {
        result.current.close();
        model.flushAll();
      });
      expect(result.current.section).toBeNull();
      act(() => {
        window.history.forward();
        model.flushAll();
      });
      expect(result.current.section).toBe("weather");
      expect(model.history.length).toBe(3);
    },
  );

  it("discards during two-delta Back restoration only after reaching the settings marker", () => {
    const model = queuedHistory();
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    rerender({ dirty: true, saving: false });
    act(() => {
      window.history.back();
      window.history.back();
      model.flushOne();
    });
    expect(model.index()).toBe(1);
    expect(result.current.pending).toBe("close");
    act(() => result.current.discardPending());
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBeNull();
    act(model.flushAll);
    expect(result.current.section).toBeNull();
    expect(model.index()).toBe(1);
    expect(model.positions).toEqual([1, 0, 1, 2, 1]);
    expect(model.history.length).toBe(3);
    rerender(clean);
    act(() => {
      window.history.forward();
      model.flushAll();
    });
    expect(result.current.section).toBe("weather");
    expect(model.index()).toBe(2);
  });

  it("adds one same-URL entry and replaces it for section changes", () => {
    const push = vi.spyOn(window.history, "pushState");
    const url = window.location.href;
    const { result } = renderHook(() => useSettingsNavigation(clean));
    expect(result.current.section).toBeNull();
    act(() => result.current.open("rss", "opener"));
    const length = window.history.length;
    expect(result.current.section).toBe("rss");
    expect(window.history.state.dashboard).toBe(true);
    act(() => result.current.select("usage"));
    act(() => result.current.open("clock_audio", "other-opener"));
    expect(result.current.section).toBe("clock_audio");
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBe(length);
    expect(window.location.href).toBe(url);
  });

  it("Back closes and Forward restores the last selected section", async () => {
    const { result } = renderHook(() => useSettingsNavigation(clean));
    act(() => result.current.open("rss", "opener"));
    act(() => result.current.select("weather"));
    act(() => window.history.back());
    await waitFor(() => expect(result.current.section).toBeNull());
    act(() => window.history.forward());
    await waitFor(() => expect(result.current.section).toBe("weather"));
  });

  it("closes through history once despite rapid repeated close and Escape", async () => {
    const back = vi.spyOn(window.history, "back");
    const { result } = renderHook(() => useSettingsNavigation(clean));
    act(() => result.current.open("usage", "opener"));
    act(() => {
      result.current.close();
      result.current.close();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => expect(result.current.section).toBeNull());
    expect(back).toHaveBeenCalledTimes(1);
    act(() => window.history.forward());
    await waitFor(() => expect(result.current.section).toBe("usage"));
  });

  it("keeps dirty input in its section until the first requested transition is decided", () => {
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    rerender({ dirty: true, saving: false });
    act(() => {
      result.current.select("rss");
      result.current.close();
      result.current.select("usage");
    });
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBe("rss");
    act(() => result.current.keepEditing());
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBeNull();
    act(() => result.current.select("usage"));
    act(() => result.current.discardPending());
    expect(result.current.section).toBe("usage");
    expect(result.current.pending).toBeNull();
  });

  it("dirty close and Escape use the same confirmation", async () => {
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    rerender({ dirty: true, saving: false });
    act(() => {
      result.current.close();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBe("close");
    act(() => result.current.discardPending());
    await waitFor(() => expect(result.current.section).toBeNull());
  });

  it("cancels dirty Back without creating history entries and still supports a later close/Forward", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    const state = window.history.state;
    const length = window.history.length;
    rerender({ dirty: true, saving: false });
    for (let i = 0; i < 3; i++) {
      act(() => window.history.back());
      await waitFor(() => expect(result.current.pending).toBe("close"));
      expect(result.current.section).toBe("weather");
      act(() => result.current.keepEditing());
      await waitFor(() => expect(window.history.state).toEqual(state));
    }
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.history.length).toBe(length);
    rerender(clean);
    act(() => result.current.close());
    await waitFor(() => expect(result.current.section).toBeNull());
    act(() => window.history.forward());
    await waitFor(() => expect(result.current.section).toBe("weather"));
  });

  it("can discard a dirty Back immediately while history restoration is still in flight", async () => {
    const forward = window.history.forward.bind(window.history);
    const heldForward = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    rerender({ dirty: true, saving: false });
    act(() => window.history.back());
    await waitFor(() => expect(result.current.pending).toBe("close"));
    act(() => result.current.discardPending());
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBeNull();
    heldForward.mockRestore();
    act(() => forward());
    await waitFor(() => expect(result.current.section).toBeNull());
    act(() => window.history.forward());
    await waitFor(() => expect(result.current.section).toBe("weather"));
  });

  it("saving blocks selects, close, discard, Escape and Back", async () => {
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    const state = window.history.state;
    rerender({ dirty: true, saving: false });
    act(() => result.current.select("usage"));
    rerender({ dirty: true, saving: true });
    const popped = vi.fn();
    window.addEventListener("popstate", popped);
    act(() => {
      result.current.discardPending();
      result.current.select("rss");
      result.current.close();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.history.back();
    });
    await waitFor(() => expect(popped).toHaveBeenCalledTimes(2));
    expect(window.history.state).toEqual(state);
    window.removeEventListener("popstate", popped);
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBe("usage");
    rerender(clean);
    act(() => result.current.keepEditing());
    act(() => result.current.close());
    await waitFor(() => expect(result.current.section).toBeNull());
  });

  it("blocks a close already in flight when saving starts before its history event", async () => {
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    const state = window.history.state;
    const popped = vi.fn();
    window.addEventListener("popstate", popped);
    act(() => result.current.close());
    rerender({ dirty: false, saving: true });
    await waitFor(() => expect(popped).toHaveBeenCalledTimes(2));
    window.removeEventListener("popstate", popped);
    expect(window.history.state).toEqual(state);
    expect(result.current.section).toBe("weather");
    expect(result.current.pending).toBeNull();
  });

  it("keeps one dirty confirmation across two rapid browser Back requests and Escape", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const { result, rerender } = renderHook(
      (guard: SettingsGuard) => useSettingsNavigation(guard),
      { initialProps: clean },
    );
    act(() => result.current.open("weather", "opener"));
    const state = window.history.state;
    const length = window.history.length;
    rerender({ dirty: true, saving: false });
    act(() => {
      window.history.back();
      window.history.back();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitFor(() => expect(result.current.pending).toBe("close"));
    await waitFor(() => expect(window.history.state).toEqual(state));
    act(() => result.current.keepEditing());
    expect(result.current.section).toBe("weather");
    expect(window.history.length).toBe(length);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("restores a valid existing settings history entry when the hook remounts", () => {
    const first = renderHook(() => useSettingsNavigation(clean));
    act(() => first.result.current.open("usage", "opener"));
    first.unmount();
    const push = vi.spyOn(window.history, "pushState");
    const next = renderHook(() => useSettingsNavigation(clean));
    expect(next.result.current.section).toBe("usage");
    expect(next.result.current.pending).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("restores opener focus only after a committed close and focuses each committed heading", async () => {
    function Harness({ guard }: { guard: SettingsGuard }) {
      const navigation = useSettingsNavigation(guard);
      return (
        <>
          <button
            id="original-opener"
            onClick={() => navigation.open("weather", "original-opener")}
          >
            開く
          </button>
          {navigation.section && (
            <>
              <h1 id={`settings-heading-${navigation.section}`} tabIndex={-1}>
                {navigation.section}
              </h1>
              <button onClick={() => navigation.select("rss")}>RSSへ</button>
              <button onClick={navigation.close}>閉じる</button>
              <button onClick={navigation.keepEditing}>続ける</button>
              <button onClick={navigation.discardPending}>破棄</button>
            </>
          )}
        </>
      );
    }
    const { rerender } = render(<Harness guard={clean} />);
    fireEvent.click(screen.getByText("開く"));
    expect(screen.getByRole("heading", { name: "weather" })).toHaveFocus();
    rerender(<Harness guard={{ dirty: true, saving: false }} />);
    fireEvent.click(screen.getByText("閉じる"));
    expect(screen.getByText("開く")).not.toHaveFocus();
    fireEvent.click(screen.getByText("続ける"));
    fireEvent.click(screen.getByText("RSSへ"));
    expect(screen.getByRole("heading", { name: "weather" })).toHaveFocus();
    fireEvent.click(screen.getByText("破棄"));
    expect(screen.getByRole("heading", { name: "rss" })).toHaveFocus();
    rerender(<Harness guard={clean} />);
    fireEvent.click(screen.getByText("閉じる"));
    await waitFor(() => expect(screen.queryByRole("heading")).toBeNull());
    expect(screen.getByText("開く")).toHaveFocus();
    act(() => window.history.forward());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "rss" })).toHaveFocus(),
    );
  });

  it("ignores Escape while closed and section selection without opening", () => {
    const back = vi.spyOn(window.history, "back");
    const { result } = renderHook(() => useSettingsNavigation(clean));
    act(() => {
      result.current.select("rss");
      result.current.close();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.section).toBeNull();
    expect(back).not.toHaveBeenCalled();
  });
});
