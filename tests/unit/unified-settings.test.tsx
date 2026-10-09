// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  emptyCommon,
  emptyUsage,
  parseSettings,
  type AppSettings,
  type Feed,
  type Usage,
} from "../../packages/contracts/src/index";
import { SettingsShell } from "../../apps/dashboard/src/settings/SettingsShell";
import type { SettingsSection } from "../../apps/dashboard/src/settings/navigation";

const feeds: Feed[] = [
  {
    ...emptyCommon("ok"),
    id: "news",
    label: "現在のニュース",
    items: [
      {
        id: "1",
        title: "記事",
        url: "https://article.example.test/story",
        publishedAt: null,
        sourceLabel: "記事元",
      },
    ],
  },
  { ...emptyCommon("error"), id: "weather", label: "防災情報", items: [] },
];
const usage: Usage[] = [
  { ...emptyUsage("claude"), status: "ok", sourceAlias: "pc" },
  {
    ...emptyUsage("codex"),
    status: "error",
    errorCode: "auth",
    sourceAlias: "pc",
  },
  emptyUsage("antigravity"),
  { ...emptyUsage("opencode_go"), status: "stale", sourceAlias: "pc" },
  { ...emptyUsage("hermes_nous"), status: "missing", sourceAlias: "pc" },
];
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("DSEG plain text license", {
          headers: { "Content-Type": "text/plain" },
        }),
      ),
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function props(section: SettingsSection = "usage") {
  return {
    value: parseSettings({}),
    usage,
    feeds,
    section,
    onChange: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    weatherPanel: <input aria-label="地域の下書き" defaultValue="東京" />,
    guard: { dirty: false, saving: false },
    pending: null,
    onDiscardPending: vi.fn(),
    onKeepEditing: vi.fn(),
  };
}

it("shows exactly the four section choices and focuses the current heading", () => {
  const initial = props();
  const { rerender } = render(<SettingsShell {...initial} />);
  const nav = screen.getByRole("navigation", { name: "設定の区分" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["RSS", "利用状況", "天気・地域", "時計・音声"]);
  for (const [section, label] of [
    ["rss", "RSS"],
    ["usage", "利用状況"],
    ["weather", "天気・地域"],
    ["clock_audio", "時計・音声"],
  ] as const) {
    rerender(<SettingsShell {...initial} section={section} />);
    expect(
      screen.getByRole("heading", { level: 1, name: label }),
    ).toHaveFocus();
    expect(within(nav).getByRole("button", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

it("shows all six exact usage labels and genuine provider states without a fabricated Grok quota", () => {
  render(<SettingsShell {...props()} />);
  const labels = [
    "Claude",
    "Codex",
    "Google AI（Antigravity）",
    "OpenCode Go",
    "Hermes / Nous",
    "Grok",
  ];
  expect(screen.getAllByRole("checkbox", { name: /表示する$/ })).toHaveLength(
    6,
  );
  for (const label of labels)
    expect(
      screen.getByRole("checkbox", { name: `${label}を表示する` }),
    ).toBeChecked();
  expect(screen.getByText("未接続・接続後に表示")).toBeVisible();
  expect(screen.getByText("受信済み")).toBeVisible();
  expect(screen.getByText("認証を確認")).toBeVisible();
  expect(screen.getByText("未接続")).toBeVisible();
  expect(screen.getByText("更新遅延")).toBeVisible();
  expect(screen.getByText("未取得")).toBeVisible();
  expect(screen.queryByText(/0%|USD|4\.7/)).toBeNull();
});

it("changes browser-only visibility immediately while preserving every other setting and the usage input", () => {
  const initial = props();
  const before = structuredClone(usage);
  function Harness() {
    const [value, setValue] = useState(initial.value);
    return (
      <SettingsShell
        {...initial}
        value={value}
        onChange={(next) => {
          initial.onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Claudeを表示する" }));
  expect(
    screen.getByRole("checkbox", { name: "Claudeを表示する" }),
  ).not.toBeChecked();
  expect(initial.onChange).toHaveBeenLastCalledWith({
    ...initial.value,
    usageVisibility: { ...initial.value.usageVisibility, claude: false },
  });
  expect(usage).toEqual(before);
});

it("shows current RSS names/status and the 15-second setting with no article-derived subscription host or CRUD", () => {
  const initial = props("rss");
  render(<SettingsShell {...initial} />);
  expect(screen.getByText("現在のニュース")).toBeVisible();
  expect(screen.getByText("防災情報")).toBeVisible();
  expect(screen.getByText("更新済み")).toBeVisible();
  expect(screen.getByText("取得エラー")).toBeVisible();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "RSSを15秒ごとに切り替える" }),
  );
  expect(initial.onChange).toHaveBeenLastCalledWith({
    ...initial.value,
    rssAutoRotate: false,
  });
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/article\.example|記事元/)).toBeNull();
  for (const name of ["追加", "編集", "削除", "保存", "並べ替え"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

it("shows an empty RSS state without inventing subscriptions", () => {
  render(<SettingsShell {...props("rss")} feeds={[]} />);
  expect(screen.getByText("RSSは未設定です")).toBeVisible();
  expect(screen.queryByRole("link")).toBeNull();
});

it("preserves weather draft content while deciding whether to leave", () => {
  const initial = props("weather");
  const { rerender } = render(
    <SettingsShell {...initial} guard={{ dirty: true, saving: false }} />,
  );
  fireEvent.change(screen.getByLabelText("地域の下書き"), {
    target: { value: "八王子" },
  });
  rerender(
    <SettingsShell
      {...initial}
      guard={{ dirty: true, saving: false }}
      pending="close"
    />,
  );
  expect(screen.getByLabelText("地域の下書き")).toHaveValue("八王子");
  expect(
    screen.getByRole("alertdialog", { name: "未保存の変更" }),
  ).toBeVisible();
  expect(screen.getByRole("alertdialog").parentElement).toHaveClass(
    "settings-confirmation-backdrop",
  );
  fireEvent.click(screen.getByRole("button", { name: "編集を続ける" }));
  expect(initial.onKeepEditing).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "変更を破棄して移動" }));
  expect(initial.onDiscardPending).toHaveBeenCalledOnce();
});

it("keeps keyboard focus in the leave confirmation and restores the edited field after cancellation", () => {
  const initial = props("weather");
  const { rerender } = render(
    <SettingsShell {...initial} guard={{ dirty: true, saving: false }} />,
  );
  const draft = screen.getByLabelText("地域の下書き");
  draft.focus();
  rerender(
    <SettingsShell
      {...initial}
      guard={{ dirty: true, saving: false }}
      pending="rss"
    />,
  );
  const dialog = screen.getByRole("alertdialog");
  const keep = screen.getByRole("button", { name: "編集を続ける" });
  const discard = screen.getByRole("button", { name: "変更を破棄して移動" });
  expect(keep).toHaveFocus();
  fireEvent.keyDown(keep, { key: "Tab", shiftKey: true });
  expect(discard).toHaveFocus();
  fireEvent.keyDown(discard, { key: "Tab" });
  expect(keep).toHaveFocus();
  draft.focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  rerender(
    <SettingsShell
      {...initial}
      guard={{ dirty: true, saving: false }}
      pending={null}
    />,
  );
  expect(draft).toHaveFocus();
});

it("focuses the committed section heading when discard changes section", () => {
  const initial = props("weather");
  const { rerender } = render(
    <SettingsShell {...initial} guard={{ dirty: true, saving: false }} />,
  );
  screen.getByLabelText("地域の下書き").focus();
  rerender(
    <SettingsShell
      {...initial}
      guard={{ dirty: true, saving: false }}
      pending="rss"
    />,
  );
  rerender(<SettingsShell {...initial} section="rss" />);
  expect(screen.getByRole("heading", { name: "RSS", level: 1 })).toHaveFocus();
});

it("disables navigation and discard during save and delegates ordinary selection/close", () => {
  const initial = props("weather");
  const { rerender } = render(<SettingsShell {...initial} />);
  fireEvent.click(screen.getByRole("button", { name: "RSS" }));
  expect(initial.onSelect).toHaveBeenCalledWith("rss");
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  expect(initial.onClose).toHaveBeenCalledOnce();
  rerender(
    <SettingsShell
      {...initial}
      guard={{ dirty: true, saving: true }}
      pending="close"
    />,
  );
  expect(
    screen.getByRole("button", { name: "変更を破棄して移動" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "時計に戻る" })).toBeDisabled();
  expect(
    within(screen.getByRole("navigation"))
      .getAllByRole("button")
      .every((button) => button.hasAttribute("disabled")),
  ).toBe(true);
  expect(screen.getByRole("status")).toHaveTextContent("保存中");
});

it("preserves existing clock/audio values and immediate changes", async () => {
  const initial = props("clock_audio");
  initial.value = parseSettings({
    timeZone: "UTC",
    hour12: true,
    audioMode: "both",
    volume: 0.7,
    quiet: { enabled: true, start: "23:00", end: "08:00" },
    usageVisibility: { claude: false },
  });
  render(<SettingsShell {...initial} />);
  expect(screen.getByLabelText("タイムゾーン")).toHaveValue("UTC");
  expect(screen.getByLabelText("12時間表記")).toBeChecked();
  expect(screen.getByLabelText("時報の種類")).toHaveValue("both");
  expect(screen.getByLabelText("アプリ内音量")).toHaveValue("70");
  expect(screen.getByLabelText("静音時間を使う")).toBeChecked();
  expect(screen.getByLabelText("静音開始")).toHaveValue("23:00");
  expect(screen.getByLabelText("静音終了")).toHaveValue("08:00");
  fireEvent.change(screen.getByLabelText("アプリ内音量"), {
    target: { value: "40" },
  });
  expect(initial.onChange).toHaveBeenLastCalledWith({
    ...initial.value,
    volume: 0.4,
  });
  fireEvent.click(screen.getByLabelText("12時間表記"));
  expect(initial.onChange).toHaveBeenLastCalledWith({
    ...initial.value,
    hour12: false,
  });
  expect(screen.getByText(/48本/)).toHaveTextContent("最初のタップ");
  expect(await screen.findByText("DSEG plain text license")).toBeVisible();
});

it("validates clock values and keeps the inline warning without saving invalid values", async () => {
  const initial = props("clock_audio");
  render(<SettingsShell {...initial} />);
  fireEvent.change(screen.getByLabelText("タイムゾーン"), {
    target: { value: "invalid-zone" },
  });
  fireEvent.blur(screen.getByLabelText("タイムゾーン"));
  expect(screen.getByRole("alert")).toHaveTextContent("timeZone");
  expect(initial.onChange).not.toHaveBeenCalled();
  await screen.findByText("DSEG plain text license");
});

it("loads DSEG from the same origin and displays markup as plain text", async () => {
  const license = "<script>window.licenseRan = true</script>\nDSEG license";
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(license, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
  const { container } = render(<SettingsShell {...props("clock_audio")} />);
  expect(
    await screen.findByText(license, { normalizer: (text) => text }),
  ).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    "/licenses/DSEG-LICENSE.txt",
    expect.objectContaining({ mode: "same-origin", redirect: "error" }),
  );
  expect(screen.queryByRole("link")).toBeNull();
});

it.each(["network", "http", "html", "empty"])(
  "shows license %s failure and retries inline",
  async (failure) => {
    if (failure === "network")
      vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    else
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(failure === "empty" ? "" : "error", {
          status: failure === "http" ? 503 : 200,
          headers: {
            "Content-Type": failure === "html" ? "text/html" : "text/plain",
          },
        }),
      );
    render(<SettingsShell {...props("clock_audio")} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ライセンスを取得できません",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "ライセンスを再読み込み" }),
    );
    expect(await screen.findByText("DSEG plain text license")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  },
);
