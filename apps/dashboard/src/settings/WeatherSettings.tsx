import { useEffect, useRef, useState } from "react";
import type {
  Weather,
  WeatherOffice,
  WeatherOffices,
  WeatherSelection,
  WeatherSettingsView,
} from "../../../../packages/contracts/src/index";
import {
  fetchWeatherSettings,
  fetchWeatherOffices,
  fetchWeatherOffice,
  saveWeatherSettings,
  WeatherSettingsError,
} from "../data/weather-settings";
const emptyDraft = (): WeatherSelection => ({
  office: "",
  region: "",
  station: "",
});
function errorMessage(error: unknown, catalog = false): string {
  const code = error instanceof WeatherSettingsError ? error.code : "network";
  if (code === "authentication_required")
    return "認証が必要です。接続を確認して再読み込みしてください。";
  if (code === "forbidden")
    return "変更には管理者権限が必要です。現在の設定を再読み込みして権限を確認してください。";
  return catalog
    ? "地域の候補を取得できません。接続を確認して候補を再読み込みしてください。"
    : "設定を取得・保存できません。接続を確認してもう一度お試しください。";
}
export function WeatherSettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (weather: Weather) => void;
}) {
  const [view, setView] = useState<WeatherSettingsView | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [enabled, setEnabled] = useState(false);
  const [offices, setOffices] = useState<WeatherOffices | null>(null);
  const [catalog, setCatalog] = useState<WeatherOffice | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [officesError, setOfficesError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [requiresReload, setRequiresReload] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false),
    mounted = useRef(true),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!savingRef.current) closeRef.current();
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setLoadError("");
    setSaveError("");
    setView(null);
    void fetchWeatherSettings(controller.signal)
      .then((next) => {
        if (!active) return;
        setView(next);
        setDraft(next.selection ?? emptyDraft());
        setEnabled(next.selection !== null);
        setRequiresReload(false);
      })
      .catch((error) => {
        if (active) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reload]);
  useEffect(() => {
    if (!view?.canEdit) {
      setOffices(null);
      setOfficesError("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setOffices(null);
    setOfficesError("");
    void fetchWeatherOffices(controller.signal)
      .then((next) => {
        if (active) setOffices(next);
      })
      .catch((error) => {
        if (active) setOfficesError(errorMessage(error, true));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [view?.canEdit, catalogRetry]);
  useEffect(() => {
    setCatalog(null);
    setCatalogError("");
    if (!view?.canEdit || !enabled || !draft.office) {
      setCatalogLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setCatalogLoading(true);
    void fetchWeatherOffice(draft.office, controller.signal)
      .then((next) => {
        if (!active) return;
        if (next.office.id !== draft.office)
          throw new WeatherSettingsError("invalid_data");
        setCatalog(next);
      })
      .catch((error) => {
        if (active) setCatalogError(errorMessage(error, true));
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [view?.canEdit, enabled, draft.office, catalogRetry]);
  const candidateError = officesError || catalogError;
  const valid =
    !enabled ||
    !!(
      offices?.offices.some((o) => o.id === draft.office) &&
      catalog?.office.id === draft.office &&
      catalog.regions.some((r) => r.id === draft.region) &&
      catalog.stations.some((s) => s.id === draft.station)
    );
  const save = async () => {
    if (savingRef.current || !view?.canEdit || requiresReload) return;
    if (!valid) {
      setSaveError(
        "予報官署・予報地方・気温の代表地点をすべて選択してください。",
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const result = await saveWeatherSettings({
        revision: view.revision,
        selection: enabled ? draft : null,
      });
      if (!mounted.current) return;
      onSaved(result.weather);
      closeRef.current();
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof WeatherSettingsError && error.uncertain) {
        setSaveError(
          "保存の応答を確認できません。サーバーに保存された可能性があります。再保存する前に現在の設定を再読み込みしてください。",
        );
        setRequiresReload(true);
      } else if (
        error instanceof WeatherSettingsError &&
        error.code === "revision_conflict"
      ) {
        setSaveError(
          "別の画面で設定が変更されました。現在の設定を再読み込みしてから選び直してください。",
        );
        setRequiresReload(true);
      } else setSaveError(errorMessage(error));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const close = () => {
    if (!savingRef.current) onClose();
  };
  return (
    <section
      className="settings-panel weather-settings"
      aria-label="天気の地域設定"
      aria-busy={loading || saving}
    >
      <div className="section-heading">
        <h1 ref={heading} tabIndex={-1}>
          天気の地域設定
        </h1>
        <button onClick={close} disabled={saving}>
          戻る
        </button>
      </div>
      {loading && <p role="status">現在の設定を読み込み中…</p>}
      {loadError && (
        <p role="alert" className="notice">
          {loadError}
        </p>
      )}
      {view && (
        <>
          <dl className="weather-current">
            <dt>現在の予報地方</dt>
            <dd>
              {view.weather.regionLabel ??
                view.selection?.region ??
                "地域未設定"}
            </dd>
            <dt>現在の気温地点</dt>
            <dd>
              {view.weather.temperatureStationLabel ??
                view.selection?.station ??
                "未設定"}
            </dd>
            <dt>予報官署 ID</dt>
            <dd>{view.selection?.office ?? "未設定"}</dd>
          </dl>
          {!view.canEdit ? (
            <p>
              変更には管理者権限が必要です。この画面は現在の設定の確認のみできます。
            </p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={saving || requiresReload}>
                <legend>表示する地域</legend>
                <label className="check weather-enabled">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                  />
                  天気を表示する
                </label>
                <div className="settings-grid">
                  <label>
                    都道府県・予報官署
                    <select
                      value={draft.office}
                      disabled={!enabled || !offices}
                      onChange={(event) => {
                        setDraft({
                          office: event.target.value,
                          region: "",
                          station: "",
                        });
                        setSaveError("");
                      }}
                    >
                      <option value="">選択してください</option>
                      {offices?.offices.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    予報地方
                    <select
                      value={draft.region}
                      disabled={
                        !enabled ||
                        catalogLoading ||
                        catalog?.office.id !== draft.office
                      }
                      onChange={(event) =>
                        setDraft({ ...draft, region: event.target.value })
                      }
                    >
                      <option value="">選択してください</option>
                      {catalog?.regions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    気温の代表地点
                    <select
                      value={draft.station}
                      disabled={
                        !enabled ||
                        catalogLoading ||
                        catalog?.office.id !== draft.office
                      }
                      onChange={(event) =>
                        setDraft({ ...draft, station: event.target.value })
                      }
                    >
                      <option value="">選択してください</option>
                      {catalog?.stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>
              {enabled && (!offices || catalogLoading) && !candidateError && (
                <p role="status">地域の候補を読み込み中…</p>
              )}
              {enabled && !valid && !catalogLoading && !candidateError && (
                <p>予報官署・予報地方・気温の代表地点を選択してください。</p>
              )}
              {candidateError && (
                <div className="notice">
                  <p role="alert">{candidateError}</p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setCatalogRetry((n) => n + 1)}
                  >
                    候補を再読み込み
                  </button>
                </div>
              )}
              {saveError && (
                <p role="alert" className="notice">
                  {saveError}
                </p>
              )}
              {saving && (
                <p role="status">
                  保存中です。応答を確認するまでこの画面を閉じられません。
                </p>
              )}
              <div className="weather-settings-actions">
                <button
                  type="submit"
                  disabled={saving || !valid || requiresReload}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                <button type="button" onClick={close} disabled={saving}>
                  キャンセル
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {(loadError || requiresReload || (saveError && !saving)) && (
        <button disabled={saving} onClick={() => setReload((n) => n + 1)}>
          現在の設定を再読み込み
        </button>
      )}
    </section>
  );
}
