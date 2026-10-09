// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { emptyDashboard } from "../../packages/contracts/src/index";
import { WeatherCard } from "../../apps/dashboard/src/cards/WeatherCard";

let stylesheet: HTMLStyleElement | undefined;
afterEach(() => {
  cleanup();
  stylesheet?.remove();
});

it("keeps weather status nonshrinking and unwrapped outside landscape-only rules", () => {
  stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(
    "apps/dashboard/src/styles.css",
    "utf8",
  );
  document.head.append(stylesheet);
  const regionLabel =
    "東京地方・多摩西部・伊豆諸島北部を含む長い予報地域の表示確認".repeat(3);
  const { container } = render(
    <WeatherCard
      value={{
        ...emptyDashboard().weather,
        status: "ok",
        regionId: "130010",
        regionLabel,
      }}
      timeZone="UTC"
      now={Date.parse("2026-10-05T00:00:00Z")}
    />,
  );
  const status = container.querySelector<HTMLElement>(".card-heading .status")!;
  expect(status).toHaveTextContent("更新済み");
  // JSDOM checks the real base CSS cascade, not native text/pixel geometry.
  // Actual portrait line count, containment and rotation are E2E assertions.
  expect(getComputedStyle(status).whiteSpace).toBe("nowrap");
  expect(getComputedStyle(status).flexShrink).toBe("0");
  expect(screen.getByRole("heading", { name: regionLabel })).toHaveTextContent(
    regionLabel,
  );
});
