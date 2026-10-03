// @vitest-environment jsdom
import React from "react";
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Clock } from "../../apps/dashboard/src/clock/Clock";
import { Settings } from "../../apps/dashboard/src/settings/Settings";
import { parseSettings } from "../../packages/contracts/src/index";
afterEach(cleanup);
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
