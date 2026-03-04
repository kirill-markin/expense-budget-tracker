"use client";

import { type ReactElement, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = Readonly<{
  reportingCurrency: string;
  availableCurrencies: ReadonlyArray<string>;
  firstDayOfWeek: number;
  timezone: string;
}>;

const DAY_KEYS: ReadonlyArray<string> = [
  "days.monday", "days.tuesday", "days.wednesday", "days.thursday",
  "days.friday", "days.saturday", "days.sunday",
];

export const WorkspaceSettings = (props: Props): ReactElement => {
  const { reportingCurrency, availableCurrencies } = props;
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>(reportingCurrency);
  const [firstDayOfWeek, setFirstDayOfWeek] = useState<number>(props.firstDayOfWeek);
  const [timezone, setTimezone] = useState<string>(props.timezone);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const dirty = selected !== reportingCurrency || firstDayOfWeek !== props.firstDayOfWeek || timezone !== props.timezone;

  const timezones = useMemo<ReadonlyArray<string>>(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);

    const body: Record<string, unknown> = {};
    if (selected !== reportingCurrency) body.reportingCurrency = selected;
    if (firstDayOfWeek !== props.firstDayOfWeek) body.firstDayOfWeek = firstDayOfWeek;
    if (timezone !== props.timezone) body.timezone = timezone;

    const response = await fetch("/api/workspace-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      setError(text);
      setSaving(false);
      return;
    }

    if (selected !== reportingCurrency) {
      window.location.reload();
      return;
    }

    setSaving(false);
    setSaved(true);
  }, [selected, firstDayOfWeek, timezone, reportingCurrency, props.firstDayOfWeek, props.timezone]);

  return (
    <div className="settings-form">
      <div className="settings-row">
        <label className="settings-label" htmlFor="reporting-currency">
          {t("settings.reportingCurrency")}
        </label>
        <div className="settings-control">
          <select id="reporting-currency" className="settings-select" value={selected}
            onChange={(e) => { setSelected(e.target.value); setSaved(false); }}>
            {availableCurrencies.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor="first-day-of-week">
          {t("settings.firstDayOfWeek")}
        </label>
        <div className="settings-control">
          <select id="first-day-of-week" className="settings-select" value={firstDayOfWeek}
            onChange={(e) => { setFirstDayOfWeek(Number(e.target.value)); setSaved(false); }}>
            {DAY_KEYS.map((key, i) => (
              <option key={i + 1} value={i + 1}>{t(key)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor="timezone">
          {t("settings.timezone")}
        </label>
        <div className="settings-control">
          <select id="timezone" className="settings-select" value={timezone}
            onChange={(e) => { setTimezone(e.target.value); setSaved(false); }}>
            {timezones.map((tz) => (<option key={tz} value={tz}>{tz}</option>))}
          </select>
          <button className="settings-save" type="button" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
        {error !== null && <div className="settings-error">{error}</div>}
        {saved && <div className="settings-saved">{t("common.saved")}</div>}
      </div>
    </div>
  );
};
