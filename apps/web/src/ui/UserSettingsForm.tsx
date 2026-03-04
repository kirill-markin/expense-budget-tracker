"use client";

import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { type SupportedLocale, type NumberFormat, type DateFormat, SUPPORTED_LOCALES, LOCALE_LABELS, NUMBER_FORMATS, DATE_FORMATS } from "@/lib/locale";

type Props = Readonly<{
  locale: SupportedLocale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
}>;

export const UserSettingsForm = (props: Props): ReactElement => {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<SupportedLocale>(props.locale);
  const [numberFormat, setNumberFormat] = useState<NumberFormat>(props.numberFormat);
  const [dateFormat, setDateFormat] = useState<DateFormat>(props.dateFormat);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const dirty = locale !== props.locale || numberFormat !== props.numberFormat || dateFormat !== props.dateFormat;

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);

    const body: Record<string, unknown> = {};
    if (locale !== props.locale) body.locale = locale;
    if (numberFormat !== props.numberFormat) body.numberFormat = numberFormat;
    if (dateFormat !== props.dateFormat) body.dateFormat = dateFormat;

    const response = await fetch("/api/user-settings", {
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

    if (locale !== props.locale) {
      window.location.reload();
      return;
    }

    setSaving(false);
    setSaved(true);
  }, [locale, numberFormat, dateFormat, props.locale, props.numberFormat, props.dateFormat]);

  return (
    <div className="settings-form">
      <div className="settings-row">
        <label className="settings-label" htmlFor="user-locale">
          {t("settings.language")}
        </label>
        <div className="settings-control">
          <select
            id="user-locale"
            className="settings-select"
            value={locale}
            onChange={(e) => { setLocale(e.target.value as SupportedLocale); setSaved(false); }}
          >
            {SUPPORTED_LOCALES.map((loc) => (
              <option key={loc} value={loc}>{LOCALE_LABELS[loc]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor="user-number-format">
          {t("settings.numberFormat")}
        </label>
        <div className="settings-control">
          <select
            id="user-number-format"
            className="settings-select"
            value={numberFormat}
            onChange={(e) => { setNumberFormat(e.target.value as NumberFormat); setSaved(false); }}
          >
            {NUMBER_FORMATS.map((fmt) => (
              <option key={fmt} value={fmt}>{fmt}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor="user-date-format">
          {t("settings.dateFormat")}
        </label>
        <div className="settings-control">
          <select
            id="user-date-format"
            className="settings-select"
            value={dateFormat}
            onChange={(e) => { setDateFormat(e.target.value as DateFormat); setSaved(false); }}
          >
            {DATE_FORMATS.map((fmt) => (
              <option key={fmt} value={fmt}>{fmt}</option>
            ))}
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
