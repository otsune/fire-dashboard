// @vitest-environment jsdom
import React from "react";
import { it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { Clock } from "../../apps/dashboard/src/clock/Clock";
import { Settings } from "../../apps/dashboard/src/settings/Settings";
import { parseSettings } from "../../packages/contracts/src/index";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("shows Tokyo hour and Japanese date", () => {
  render(
    <Clock
      settings={parseSettings({})}
      now={() => Date.parse("2026-10-02T01:00:00Z")}
    />,
  );
  expect(screen.getByTestId("clock-time")).toHaveTextContent("10:00");
  expect(screen.getByText(/10月2日/)).toBeInTheDocument();
});
it("supports UTC and 12-hour noon", () => {
  render(
    <Clock
      settings={parseSettings({ timeZone: "UTC", hour12: true })}
      now={() => Date.parse("2026-10-02T12:00:00Z")}
    />,
  );
  expect(screen.getByTestId("clock-time")).toHaveTextContent("12:00");
  expect(screen.getByText("午後")).toBeInTheDocument();
});
it("supports a zero-padded UTC hour", () => {
  render(
    <Clock
      settings={parseSettings({ timeZone: "UTC" })}
      now={() => Date.parse("2026-10-02T01:00:00Z")}
    />,
  );
  expect(screen.getByTestId("clock-time")).toHaveTextContent("01:00");
});
it("separates hours and minutes for rotation while exposing one complete readable time", () => {
  render(
    <Clock
      settings={parseSettings({ timeZone: "UTC" })}
      now={() => Date.parse("2026-10-02T01:23:45Z")}
    />,
  );
  const time = screen.getByRole("timer", { name: "01時23分45秒 UTC" });
  expect(time).toHaveAttribute("aria-live", "off");
  const digits = screen.getByTestId("clock-time");
  expect(digits).toHaveAttribute("aria-hidden", "true");
  expect(digits.querySelector(".clock-hours")).toHaveTextContent("01");
  expect(digits.querySelector(".clock-minutes")).toHaveTextContent("23");
  expect(digits.querySelector(".clock-separator")).toHaveTextContent(":");
  expect(time).not.toContainElement(screen.getByTestId("clock-seconds"));
});
it("includes the 12-hour period in the accessible time and updates at midnight", () => {
  vi.useFakeTimers();
  let now = Date.parse("2026-10-02T23:59:59Z");
  render(
    <Clock
      settings={parseSettings({ timeZone: "UTC", hour12: true })}
      now={() => now}
    />,
  );
  expect(screen.getByRole("timer")).toHaveAccessibleName(
    "午後11時59分59秒 UTC",
  );
  now += 1000;
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByRole("timer")).toHaveAccessibleName(
    "午前12時00分00秒 UTC",
  );
  expect(screen.getByTestId("clock-seconds")).toHaveTextContent("00");
  expect(screen.getByText(/10月3日/)).toBeInTheDocument();
});
it("settings changes propagate and return is explicit", () => {
  let volume = 0.3,
    closed = false;
  render(
    <Settings
      value={parseSettings({})}
      onChange={(s) => {
        volume = s.volume;
      }}
      onClose={() => {
        closed = true;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("アプリ内音量"), {
    target: { value: "70" },
  });
  expect(volume).toBe(0.7);
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  expect(closed).toBe(true);
});
