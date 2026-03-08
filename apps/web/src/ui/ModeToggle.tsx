"use client";

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import styles from "./Controls.module.css";

type Props = Readonly<{
  isDemoMode: boolean;
}>;

export const ModeToggle = (props: Props): ReactElement => {
  const { isDemoMode } = props;
  const { visibilityMode, setVisibilityMode } = useFilteredMode();
  const { t } = useTranslation();

  const activeMode: "all" | "filtered" | "demo" = isDemoMode ? "demo" : visibilityMode;

  const switchTo = (target: "all" | "filtered" | "demo"): void => {
    if (target === activeMode) return;

    if (target === "demo") {
      document.cookie = "demo=true; path=/; max-age=31536000";
      window.location.reload();
      return;
    }

    if (isDemoMode) {
      // Leaving demo mode — store target mode in localStorage before reload
      localStorage.setItem("expense-tracker-visibility-mode", target);
      document.cookie = "demo=; path=/; max-age=0";
      window.location.reload();
      return;
    }

    // All ↔ Filtered: instant, no reload
    setVisibilityMode(target);
  };

  return (
    <div className={styles.segmented}>
      <button
        className={cn(styles.segment, activeMode === "all" ? styles.segmentActive : "")}
        type="button"
        onClick={() => switchTo("all")}
      >
        {t("mode.all")}
      </button>
      <button
        className={cn(styles.segment, activeMode === "filtered" ? styles.segmentActive : "")}
        type="button"
        onClick={() => switchTo("filtered")}
      >
        {t("mode.filtered")}
      </button>
      <button
        className={cn(styles.segment, activeMode === "demo" ? styles.segmentActive : "")}
        type="button"
        onClick={() => switchTo("demo")}
      >
        {t("mode.demo")}
      </button>
    </div>
  );
};
