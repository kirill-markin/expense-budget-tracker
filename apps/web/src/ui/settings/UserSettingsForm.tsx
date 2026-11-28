"use client";

import {
  COMPACT_LOCALE_PICKER_LIMIT,
  createLocalePickerOptions,
  normalizeLocaleSearch,
} from "@expense-budget-tracker/agent-shared/locales";
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
  LOCALE_REGISTRY,
  NUMBER_FORMATS,
  SUPPORTED_LOCALES,
} from "@/lib/locale";
import { parseLocaleHint, reloadWithoutLocaleHint } from "@/lib/localeHint";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { useLowercase } from "@/ui/LowercaseProvider";
import { AppearanceSettings } from "./AppearanceSettings";

import styles from "./SettingsForm.module.css";

type Props = Readonly<{
  locale: SupportedLocale;
  effectiveLocale: SupportedLocale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
}>;

const localeOptions = createLocalePickerOptions(SUPPORTED_LOCALES, LOCALE_REGISTRY);
const hasLocaleSearch = localeOptions.length > COMPACT_LOCALE_PICKER_LIMIT;

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

const parseAutoFilterDelayMinutes = (raw: string): AutoFilterDelayMinutes | undefined => {
  if (raw === AUTO_FILTER_DELAY_DISABLED_VALUE) {
    return null;
  }

  const value = Number(raw);
  if ((AUTO_FILTER_DELAY_MINUTES as ReadonlyArray<number>).includes(value)) {
    return value as EnabledAutoFilterDelayMinutes;
  }

  return undefined;
};

const handleUseSavedLanguage = (): void => {
  const url = new URL(window.location.href);
  if (parseLocaleHint(url.searchParams) !== null) reloadWithoutLocaleHint(url);
};

export const UserSettingsForm = (props: Props): ReactElement => {
  const { t } = useTranslation();
  const { isDemoMode, updateAutoFilterDelayMinutes } = useFilteredMode();
  const { lowercase, setLowercase, savedLowercase, setSavedLowercase } = useLowercase();
  const [locale, setLocale] = useState<SupportedLocale>(props.locale);
  const [localeSearch, setLocaleSearch] = useState<string>("");
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
  const [invalidDelay, setInvalidDelay] = useState<string | null>(null);

  const localeQuery = normalizeLocaleSearch(localeSearch);
  const visibleLocaleOptions = localeOptions.filter(({ id, searchText }) =>
    id === locale || searchText.includes(localeQuery),
  );
  const hasLocaleMatches = visibleLocaleOptions.some(({ searchText }) => searchText.includes(localeQuery));

  const dirty =
    lowercase !== savedLowercase ||
    locale !== props.locale ||
    numberFormat !== props.numberFormat ||
    dateFormat !== props.dateFormat ||
    autoFilterDelayMinutes !== savedAutoFilterDelayMinutes;

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);

    const localeChanged = locale !== props.locale;
    const demoLocaleSaveLocation = localeChanged && isDemoMode
      ? { pathname: window.location.pathname, search: window.location.search }
      : null;
    const body: Record<string, unknown> = {};
    if (lowercase !== savedLowercase) body.lowercase = lowercase;
    if (localeChanged) body.locale = locale;
    if (numberFormat !== props.numberFormat) body.numberFormat = numberFormat;
    if (dateFormat !== props.dateFormat) body.dateFormat = dateFormat;
    if (autoFilterDelayMinutes !== savedAutoFilterDelayMinutes) body.autoFilterDelayMinutes = autoFilterDelayMinutes;

    try {
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

      setSavedLowercase(lowercase);

      const canReload = demoLocaleSaveLocation === null || (
        window.location.pathname === demoLocaleSaveLocation.pathname &&
        window.location.search === demoLocaleSaveLocation.search
      );
      if (canReload && (localeChanged || numberFormat !== props.numberFormat || dateFormat !== props.dateFormat)) {
        if (demoLocaleSaveLocation !== null) {
          reloadWithoutLocaleHint(new URL(window.location.href));
        } else {
          window.location.reload();
        }
        return;
      }

      setSaving(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [
    autoFilterDelayMinutes,
    dateFormat,
    isDemoMode,
    locale,
    lowercase,
    savedLowercase,
    setSavedLowercase,
    numberFormat,
    props.dateFormat,
    props.locale,
    props.numberFormat,
    savedAutoFilterDelayMinutes,
    updateAutoFilterDelayMinutes,
  ]);

  return (
    <div className={styles.form}>
      <AppearanceSettings />
      <div className={styles.row}>
        <label className={styles.checkboxLabel} htmlFor="user-lowercase">
          <input
            id="user-lowercase"
            type="checkbox"
            checked={lowercase}
            disabled={saving}
            aria-describedby="user-lowercase-hint"
            onChange={(event) => { setLowercase(event.target.checked); setSaved(false); }}
          />
          {t("settings.lowercase")}
        </label>
        <p id="user-lowercase-hint" className={styles.label} style={{ margin: 0 }}>
          {t("settings.lowercaseHint")}
        </p>
      </div>

      <div className={styles.row}>
        {hasLocaleSearch && (
          <>
            <label className={styles.label} htmlFor="user-locale-search">
              {t("settings.languageSearch")}
            </label>
            <div className={styles.control}>
              <input
                id="user-locale-search"
                type="search"
                autoComplete="off"
                dir="auto"
                className={styles.input}
                value={localeSearch}
                aria-controls="user-locale"
                onChange={(event) => setLocaleSearch(event.target.value)}
              />
            </div>
          </>
        )}
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
            {visibleLocaleOptions.map(({ id, tag, direction, label }) => (
              <option key={id} value={id} lang={tag} dir={hasLocaleSearch ? direction : undefined}>{label}</option>
            ))}
          </select>
        </div>
        {hasLocaleSearch && (
          <span className={styles.label} role="status">
            {hasLocaleMatches ? "" : t("settings.noLanguageMatches")}
          </span>
        )}
        {isDemoMode && props.effectiveLocale !== props.locale && (
          <button
            id="user-use-saved-language"
            type="button"
            className={styles.inlineLink}
            onClick={handleUseSavedLanguage}
            disabled={saving}
          >
            {t("settings.useSavedLanguage")}
          </button>
        )}
      </div>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="user-number-format">
          {t("settings.numberFormat")}
        </label>
        <div className={styles.control}>
          <select
            id="user-number-format"
            dir="ltr"
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
            aria-invalid={invalidDelay !== null}
            aria-describedby="user-auto-filter-delay-hint"
            onChange={(event) => {
              const rawValue = event.target.value;
              const delay = parseAutoFilterDelayMinutes(rawValue);
              setInvalidDelay(delay === undefined ? rawValue : null);
              setSaved(false);
              if (delay !== undefined) setAutoFilterDelayMinutes(delay);
            }}
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
        {invalidDelay !== null && (
          <div className={styles.error} role="alert">{t("settings.invalidAutoFilterDelay", { value: invalidDelay })}</div>
        )}
        {error !== null && (
          <div className={styles.error} role="alert"><strong>{t("common.saveFailed")}</strong> {error}</div>
        )}
        {saved && <div className={styles.saved}>{t("common.saved")}</div>}
      </div>
    </div>
  );
};
