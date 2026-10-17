"use client";

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { parseThemePreference } from "@/lib/theme";
import { useTheme } from "@/ui/ThemeProvider";

import styles from "./SettingsForm.module.css";

export const AppearanceSettings = (): ReactElement => {
  const { t } = useTranslation();
  const { preference, ready, error, setPreference } = useTheme();

  return (
    <div className={styles.row}>
      <label className={styles.label} htmlFor="appearance-theme">
        {t("settings.theme")}
      </label>
      <div className={styles.control}>
        <select
          id="appearance-theme"
          className={styles.select}
          value={preference}
          disabled={!ready}
          aria-describedby="appearance-theme-hint"
          onChange={(event) => setPreference(parseThemePreference(event.target.value))}
        >
          <option value="system">{t("settings.themeSystem")}</option>
          <option value="light">{t("settings.themeLight")}</option>
          <option value="dark">{t("settings.themeDark")}</option>
        </select>
      </div>
      <p id="appearance-theme-hint" className={styles.label} style={{ margin: 0 }}>
        {t("settings.themeHint")}
      </p>
      {error !== null && (
        <div className={styles.error}>{t("settings.themeSaveError", { message: error })}</div>
      )}
    </div>
  );
};
