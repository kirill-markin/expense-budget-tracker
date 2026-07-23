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
  const {
    visibilityMode,
    modeTransitionPending,
    requestModeTransition,
  } = useFilteredMode();
  const { t } = useTranslation();

  const activeMode: "all" | "filtered" | "demo" = isDemoMode ? "demo" : visibilityMode;

  const switchTo = (target: "all" | "filtered" | "demo"): void => {
    if (target === activeMode) return;
    void requestModeTransition(target);
  };

  return (
    <div
      className={styles.segmented}
      data-table-editor-visibility-control="true"
      aria-busy={modeTransitionPending}
    >
      <button
        className={cn(styles.segment, activeMode === "all" ? styles.segmentActive : "")}
        type="button"
        data-testid="mode-all"
        aria-pressed={activeMode === "all"}
        disabled={modeTransitionPending}
        onClick={() => switchTo("all")}
      >
        {t("mode.all")}
      </button>
      <button
        className={cn(styles.segment, activeMode === "filtered" ? styles.segmentActive : "")}
        type="button"
        data-testid="mode-filtered"
        aria-pressed={activeMode === "filtered"}
        disabled={modeTransitionPending}
        onClick={() => switchTo("filtered")}
      >
        {t("mode.filtered")}
      </button>
      <button
        className={cn(styles.segment, activeMode === "demo" ? styles.segmentActive : "")}
        type="button"
        data-testid="mode-demo"
        aria-pressed={activeMode === "demo"}
        disabled={modeTransitionPending}
        onClick={() => switchTo("demo")}
      >
        {t("mode.demo")}
      </button>
    </div>
  );
};
