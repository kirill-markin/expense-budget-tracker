"use client";

import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchWithCsrf } from "@/lib/csrf";
import {
  AUTO_FILTER_DELAY_MINUTES,
  type AutoFilterDelayMinutes,
  type DateFormat,
  type EnabledAutoFilterDelayMinutes,
  type NumberFormat,
  type SupportedLocale,
  DATE_FORMATS,
  LOCALE_LABELS,
  NUMBER_FORMATS,
  SUPPORTED_LOCALES,
} from "@/lib/locale";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import styles from "./SettingsForm.module.css";

type Props = Readonly<{
  locale: SupportedLocale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
}>;

const AUTO_FILTER_DELAY_DISABLED_VALUE = "never";

const AUTO_FILTER_DELAY_LABEL_KEYS: Readonly<Record<EnabledAutoFilterDelayMinutes, string>> = {
  1: "settings.autoFilterDelayAfter1Minute",
  2: "settings.autoFilterDelayAfter2Minutes",
  5: "settings.autoFilterDelayAfter5Minutes",
  10: "settings.autoFilterDelayAfter10Minutes",
  30: "settings.autoFilterDelayAfter30Minutes",
};

const serializeAutoFilterDelayMinutes = (
  autoFilterDelayMinutes: AutoFilterDelayMinutes,
): string => autoFilterDelayMinutes === null ? AUTO_FILTER_DELAY_DISABLED_VALUE : String(autoFilterDelayMinutes);

const parseAutoFilterDelayMinutes = (raw: string): AutoFilterDelayMinutes => {
  if (raw === AUTO_FILTER_DELAY_DISABLED_VALUE) {
    return null;
  }

  const value = Number(raw);
  if ((AUTO_FILTER_DELAY_MINUTES as ReadonlyArray<number>).includes(value)) {
    return value as EnabledAutoFilterDelayMinutes;
  }

  throw new Error(`Unsupported auto filter delay option "${raw}".`);
};

export const UserSettingsForm = (props: Props): ReactElement => {
  const { t } = useTranslation();
  const { updateAutoFilterDelayMinutes } = useFilteredMode();
  const [locale, setLocale] = useState<SupportedLocale>(props.locale);
  const [numberFormat, setNumberFormat] = useState<NumberFormat>(props.numberFormat);
  const [dateFormat, setDateFormat] = useState<DateFormat>(props.dateFormat);
  const [autoFilterDelayMinutes, setAutoFilterDelayMinutes] = useState<AutoFilterDelayMinutes>(
    props.autoFilterDelayMinutes,
  );
  const [savedAutoFilterDelayMinutes, setSavedAutoFilterDelayMinutes] = useState<AutoFilterDelayMinutes>(
    props.autoFilterDelayMinutes,
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const dirty =
    locale !== props.locale ||
    numberFormat !== props.numberFormat ||
    dateFormat !== props.dateFormat ||
    autoFilterDelayMinutes !== savedAutoFilterDelayMinutes;

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);

    const body: Record<string, unknown> = {};
    if (locale !== props.locale) body.locale = locale;
    if (numberFormat !== props.numberFormat) body.numberFormat = numberFormat;
    if (dateFormat !== props.dateFormat) body.dateFormat = dateFormat;
    if (autoFilterDelayMinutes !== savedAutoFilterDelayMinutes) body.autoFilterDelayMinutes = autoFilterDelayMinutes;

    const response = await fetchWithCsrf("/api/user-settings", {
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

    if (autoFilterDelayMinutes !== savedAutoFilterDelayMinutes) {
      updateAutoFilterDelayMinutes(autoFilterDelayMinutes);
      setSavedAutoFilterDelayMinutes(autoFilterDelayMinutes);
    }

    if (locale !== props.locale || numberFormat !== props.numberFormat || dateFormat !== props.dateFormat) {
      window.location.reload();
      return;
    }

    setSaving(false);
    setSaved(true);
  }, [
    autoFilterDelayMinutes,
    dateFormat,
    locale,
    numberFormat,
    props.dateFormat,
    props.locale,
    props.numberFormat,
    savedAutoFilterDelayMinutes,
    updateAutoFilterDelayMinutes,
  ]);

  return (
    <div className={styles.form}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="user-locale">
          {t("settings.language")}
        </label>
        <div className={styles.control}>
          <select
            id="user-locale"
            className={styles.select}
            value={locale}
            onChange={(e) => { setLocale(e.target.value as SupportedLocale); setSaved(false); }}
          >
            {SUPPORTED_LOCALES.map((loc) => (
              <option key={loc} value={loc}>{LOCALE_LABELS[loc]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="user-number-format">
          {t("settings.numberFormat")}
        </label>
        <div className={styles.control}>
          <select
            id="user-number-format"
            className={styles.select}
            value={numberFormat}
            onChange={(e) => { setNumberFormat(e.target.value as NumberFormat); setSaved(false); }}
          >
            {NUMBER_FORMATS.map((fmt) => (
              <option key={fmt} value={fmt}>{fmt}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="user-date-format">
          {t("settings.dateFormat")}
        </label>
        <div className={styles.control}>
          <select
            id="user-date-format"
            className={styles.select}
            value={dateFormat}
            onChange={(e) => { setDateFormat(e.target.value as DateFormat); setSaved(false); }}
          >
            {DATE_FORMATS.map((fmt) => (
              <option key={fmt} value={fmt}>{fmt}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="user-auto-filter-delay">
          {t("settings.autoFilterDelay")}
        </label>
        <div className={styles.control}>
          <select
            id="user-auto-filter-delay"
            className={styles.select}
            value={serializeAutoFilterDelayMinutes(autoFilterDelayMinutes)}
            aria-describedby="user-auto-filter-delay-hint"
            onChange={(e) => { setAutoFilterDelayMinutes(parseAutoFilterDelayMinutes(e.target.value)); setSaved(false); }}
          >
            <option value={AUTO_FILTER_DELAY_DISABLED_VALUE}>{t("settings.autoFilterDelayNever")}</option>
            {AUTO_FILTER_DELAY_MINUTES.map((delayMinutes) => (
              <option key={delayMinutes} value={String(delayMinutes)}>
                {t(AUTO_FILTER_DELAY_LABEL_KEYS[delayMinutes])}
              </option>
            ))}
          </select>
        </div>
        <p id="user-auto-filter-delay-hint" className={styles.label} style={{ margin: 0 }}>
          {t("settings.autoFilterDelayHint")}
        </p>
      </div>

      <div className={styles.row}>
        <div className={styles.control}>
          <button className={styles.save} type="button" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
        {error !== null && <div className={styles.error}>{error}</div>}
        {saved && <div className={styles.saved}>{t("common.saved")}</div>}
      </div>
    </div>
  );
};
