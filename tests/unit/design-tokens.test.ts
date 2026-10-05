import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokensPath = "apps/dashboard/src/styles/tokens.css";

function hexToRgb(value: string) {
  const hex = value.slice(1);
  return [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
}

function luminance(value: string) {
  const channels = hexToRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function tokens() {
  const css = readFileSync(tokensPath, "utf8");
  return new Map(
    [
      ...css.matchAll(/(--fd-[\w-]+):\s*(#[0-9a-f]{6}|[\d.]+(?:rem|px)?);/gi),
    ].map(([, name, value]) => [name, value.toLowerCase()]),
  );
}

describe("Fire Dashboard design tokens", () => {
  it("defines the reviewed semantic colors and sizing values", () => {
    const values = tokens();
    expect(values.get("--fd-surface-page")).toBe("#101617");
    expect(values.get("--fd-border-control")).toBe("#718d82");
    expect(values.get("--fd-warning")).toBe("#f0b86e");
    expect(values.get("--fd-focus-yellow")).toBe("#ffd43d");
    expect(values.get("--fd-focus-black")).toBe("#000000");
    expect(values.get("--fd-touch-min")).toBe("44px");
    expect(values.get("--fd-control-height")).toBe("48px");
    expect(values.get("--fd-font-body")).toBe("1rem");
    expect(values.get("--fd-font-small")).toBe("0.875rem");
  });

  it("keeps reviewed text and control boundaries above their contrast floors", () => {
    const values = tokens();
    const get = (name: string) => values.get(name)!;
    expect(
      contrast(get("--fd-text-secondary"), get("--fd-surface-card")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(get("--fd-text-muted"), get("--fd-surface-card")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(get("--fd-border-control"), get("--fd-surface-input")),
    ).toBeGreaterThanOrEqual(3);
    expect(
      contrast(get("--fd-action-text"), get("--fd-action")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("loads tokens before component CSS", () => {
    const main = readFileSync("apps/dashboard/src/main.tsx", "utf8");
    expect(main.indexOf('import "./styles/tokens.css"')).toBeGreaterThanOrEqual(
      0,
    );
    expect(main.indexOf('import "./styles/tokens.css"')).toBeLessThan(
      main.indexOf('import "./styles.css"'),
    );
  });
});
