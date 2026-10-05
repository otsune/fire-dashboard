import { expect, test } from "@playwright/test";
import { openSettings, setupSettings } from "./settings-fixture";

test.use({ serviceWorkers: "block" });

test("semantic tokens produce distinct focus, selected, disabled and success styles", async ({
  page,
}) => {
  await setupSettings(page);
  const settingsButton = page.getByRole("button", {
    name: "設定",
    exact: true,
  });
  await settingsButton.focus();
  await expect(settingsButton).toBeFocused();
  expect(
    await settingsButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        boxShadow: style.boxShadow,
        borderRadius: style.borderRadius,
      };
    }),
  ).toEqual({
    outlineColor: "rgb(255, 212, 61)",
    outlineStyle: "solid",
    outlineWidth: "3px",
    outlineOffset: "2px",
    boxShadow: "rgb(0, 0, 0) 0px 0px 0px 2px",
    borderRadius: "9px",
  });

  await openSettings(page, true);
  const current = page.locator('.settings-sections [aria-current="page"]');
  await expect(current).toHaveCSS("font-weight", "700");
  await expect(current).toHaveCSS("box-shadow", /rgb\(184, 214, 162\)/);
  await current.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(current).toBeFocused();
  await expect(current).toHaveCSS(
    "box-shadow",
    /rgb\(0, 0, 0\).*rgb\(184, 214, 162\)/,
  );
  await current.evaluate((element) => element.setAttribute("disabled", ""));
  await expect(current).toHaveCSS("background-color", "rgb(32, 44, 44)");
  await expect(current).toHaveCSS("border-color", "rgb(113, 141, 130)");
  await current.evaluate((element) => element.removeAttribute("disabled"));
  const save = page.getByRole("button", { name: "保存", exact: true });
  for (
    let index = 0;
    index < 20 &&
    !(await save.evaluate((element) => element === document.activeElement));
    index++
  )
    await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  expect(
    await save.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  await expect(save).toHaveCSS("background-color", "rgb(184, 214, 162)");
  await expect(save).toHaveCSS("outline-color", "rgb(255, 212, 61)");
  await expect(save).toHaveCSS("box-shadow", "rgb(0, 0, 0) 0px 0px 0px 2px");
  await page.screenshot({
    path: "artifacts/p1-p2/focus-primary.png",
    fullPage: true,
  });

  const enabled = page.getByRole("checkbox", { name: "天気を表示する" });
  await enabled.uncheck();
  const office = page.locator(".weather-settings select").first();
  await expect(office).toBeDisabled();
  await expect(office).toHaveCSS("border-color", "rgb(113, 141, 130)");
  await expect(office).toHaveCSS("opacity", "1");

  await enabled.check();
  await page.locator(".weather-settings select").nth(2).selectOption("44133");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const success = page.getByRole("status").filter({ hasText: "保存しました" });
  await expect(success).toHaveText("保存しました");
  expect(
    await success.evaluate(
      (element) => getComputedStyle(element, "::before").content,
    ),
  ).toBe('"✓ "');
  await expect(success).toHaveCSS("color", "rgb(166, 217, 179)");
  await expect(success).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({
    path: "artifacts/p1-p2/save-success.png",
    fullPage: true,
  });
});

test("all settings sections stay reachable in a 200 percent reflow-equivalent viewport", async ({
  page,
}) => {
  await setupSettings(page);
  await openSettings(page);
  const panel = page.locator(".unified-settings");
  await expect(panel).toHaveCSS("font-size", "16px");
  await page.getByRole("button", { name: "RSS", exact: true }).click();
  await expect(page.locator(".settings-help")).toHaveCSS("font-size", "14px");
  for (const control of await page.locator(".settings-sections button").all()) {
    const bounds = await control.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(48);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
  }
  const checkboxRow = page.locator(".settings-grid .check").first();
  expect((await checkboxRow.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await page.setViewportSize({ width: 640, height: 400 });
  for (const name of ["RSS", "利用状況", "天気・地域", "時計・音声"]) {
    const section = page.getByRole("button", { name, exact: true });
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    await section.click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await page.screenshot({
    path: "artifacts/p1-p2/settings-200-percent.png",
    fullPage: true,
  });
});
