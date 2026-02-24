"use client";

import { type ReactElement, useCallback, useState } from "react";

type Props = Readonly<{
  reportingCurrency: string;
  availableCurrencies: ReadonlyArray<string>;
}>;

export const WorkspaceSettings = (props: Props): ReactElement => {
  const { reportingCurrency, availableCurrencies } = props;
  const [selected, setSelected] = useState<string>(reportingCurrency);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const dirty = selected !== reportingCurrency;

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const response = await fetch("/api/workspace-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportingCurrency: selected }),
    });
    if (!response.ok) {
      const text = await response.text();
      setError(text);
      setSaving(false);
      return;
    }
    window.location.reload();
  }, [selected]);

  return (
    <div className="settings-form">
      <div className="settings-row">
        <label className="settings-label" htmlFor="reporting-currency">
          Reporting currency
        </label>
        <div className="settings-control">
          <select
            id="reporting-currency"
            className="settings-select"
            value={selected}
            onChange={(e) => { setSelected(e.target.value); setSaved(false); }}
          >
            {availableCurrencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button
            className="settings-save"
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
        {error !== null && <div className="settings-error">{error}</div>}
        {saved && <div className="settings-saved">Saved</div>}
      </div>
    </div>
  );
};
