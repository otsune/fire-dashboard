import { useEffect, useRef, type ReactNode } from "react";
import type {
  AppSettings,
  Feed,
  Usage,
} from "../../../../packages/contracts/src/index";
import type { SettingsGuard, SettingsSection } from "./navigation";
import { RssSettings } from "./RssSettings";
import { UsageSettings } from "./UsageSettings";
import { ClockAudioSettings } from "./ClockAudioSettings";
export type SettingsShellProps = {
  value: AppSettings;
  usage: Usage[];
  feeds: Feed[];
  section: SettingsSection;
  onChange: (value: AppSettings) => void;
  onSelect: (section: SettingsSection) => void;
  onClose: () => void;
  weatherPanel: ReactNode;
  guard: SettingsGuard;
  pending: SettingsSection | "close" | null;
  onDiscardPending: () => void;
  onKeepEditing: () => void;
};
const sections: { id: SettingsSection; label: string }[] = [
  { id: "rss", label: "RSS" },
  { id: "usage", label: "利用状況" },
  { id: "weather", label: "天気・地域" },
  { id: "clock_audio", label: "時計・音声" },
];

export function SettingsShell({
  value,
  usage,
  feeds,
  section,
  onChange,
  onSelect,
  onClose,
  weatherPanel,
  guard,
  pending,
  onDiscardPending,
  onKeepEditing,
}: SettingsShellProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const focusBeforeConfirmation = useRef<{
    element: HTMLElement | null;
    section: SettingsSection;
  } | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [section]);
  useEffect(() => {
    if (!pending) {
      const previous = focusBeforeConfirmation.current;
      if (previous?.section === section && previous.element?.isConnected)
        previous.element.focus();
      focusBeforeConfirmation.current = null;
      return;
    }
    if (!focusBeforeConfirmation.current)
      focusBeforeConfirmation.current = {
        element:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
        section,
      };
    keepButton.current?.focus();
    const containFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !confirmation.current?.contains(event.target)
      )
        keepButton.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    return () => document.removeEventListener("focusin", containFocus);
  }, [pending, section]);
  return (
    <section
      className="settings-panel unified-settings"
      aria-label="設定"
      aria-busy={guard.saving}
    >
      <div className="section-heading" inert={pending !== null}>
        <h1 id={`settings-heading-${section}`} ref={heading} tabIndex={-1}>
          {sections.find((item) => item.id === section)?.label}
        </h1>
        <button disabled={guard.saving} onClick={onClose}>
          時計に戻る
        </button>
      </div>
      <nav
        className="settings-sections"
        aria-label="設定の区分"
        inert={pending !== null}
      >
        {sections.map(({ id, label }) => (
          <button
            key={id}
            disabled={guard.saving}
            aria-current={id === section ? "page" : undefined}
            onClick={() => onSelect(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-section-content" inert={pending !== null}>
        {section === "rss" && (
          <RssSettings value={value} feeds={feeds} onChange={onChange} />
        )}
        {section === "usage" && (
          <UsageSettings value={value} usage={usage} onChange={onChange} />
        )}
        {section === "weather" && weatherPanel}
        {section === "clock_audio" && (
          <ClockAudioSettings value={value} onChange={onChange} />
        )}
      </div>
      {guard.saving && (
        <p className="notice" role="status">
          保存中です。応答を確認するまでこの画面を閉じられません。
        </p>
      )}
      {pending && (
        <div className="settings-confirmation-backdrop">
          <div
            ref={confirmation}
            className="settings-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="settings-confirm-title"
            aria-describedby="settings-confirm-description"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const buttons = Array.from(
                confirmation.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ) ?? [],
              );
              if (!buttons.length) return;
              event.preventDefault();
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              buttons[
                index < 0
                  ? 0
                  : (index + (event.shiftKey ? -1 : 1) + buttons.length) %
                    buttons.length
              ]?.focus();
            }}
          >
            <h2 id="settings-confirm-title">未保存の変更</h2>
            <p id="settings-confirm-description">
              変更を破棄して移動しますか？編集を続けると入力はそのまま残ります。
            </p>
            <div className="settings-confirm-actions">
              <button ref={keepButton} onClick={onKeepEditing}>
                編集を続ける
              </button>
              <button disabled={guard.saving} onClick={onDiscardPending}>
                変更を破棄して移動
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
