"use client";

import { useLayoutEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { FilteredModeSettings } from "@/ui/FilteredBanner";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import styles from "./Controls.module.css";

type Props = Readonly<{
  isDemoMode: boolean;
}>;

export const ModeToggle = (props: Props): ReactElement => {
  const { isDemoMode } = props;
  const modeRef = useRef<HTMLDivElement>(null);
  const {
    visibilityMode,
    modeTransitionPending,
    requestModeTransition,
  } = useFilteredMode();
  const { t } = useTranslation();

  const activeMode: "all" | "filtered" | "demo" = isDemoMode ? "demo" : visibilityMode;

  // Fit translated labels and optional account/chat controls without truncation.
  // Only widths are compared, so the same ladder applies in LTR and RTL.
  useLayoutEffect(() => {
    const mode = modeRef.current;
    const header = mode?.closest<HTMLElement>(".topbar");
    const brand = header?.querySelector<HTMLElement>(".topbar-brand");
    const actions = header?.querySelector<HTMLElement>(".topbar-end");
    if (!mode || !header || !brand || !actions) return;
    const media = window.matchMedia("(max-width: 1099px), (pointer: coarse)");
    const fit = (): void => {
      if (!media.matches) {
        delete header.dataset.headerLayout;
        return;
      }
      const css = getComputedStyle(header);
      const available = header.clientWidth - parseFloat(css.paddingInlineStart) - parseFloat(css.paddingInlineEnd);
      const gap = parseFloat(css.columnGap);
      const modeWidth = mode.getBoundingClientRect().width;
      const brandWidth = brand.getBoundingClientRect().width;
      const actionsWidth = actions.getBoundingClientRect().width;
      const settings = mode.parentElement?.querySelector<HTMLElement>(".header-mode-settings");
      const settingsSpace = settings ? settings.getBoundingClientRect().width + 4 : 0;
      const centered = modeWidth + 2 * Math.max(brandWidth + gap, actionsWidth + settingsSpace + gap);
      const compact = brandWidth + modeWidth + settingsSpace + actionsWidth + 2 * gap;
      const brandless = modeWidth + settingsSpace + actionsWidth + gap;
      header.dataset.headerLayout = available >= centered ? "centered"
        : available >= compact ? "compact"
        : available >= brandless ? "brandless" : "stacked";
    };
    const observer = new ResizeObserver(fit);
    [header, brand, mode, actions].forEach(element => observer.observe(element));
    media.addEventListener("change", fit);
    fit();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", fit);
    };
  }, [visibilityMode, isDemoMode]);

  const switchTo = (target: "all" | "filtered" | "demo"): void => {
    if (target === activeMode) return;
    void requestModeTransition(target);
  };

  return (
    <div className="topbar-actions header-mode">
      <div
        ref={modeRef}
        className={cn(styles.segmented, styles.modeToggle, "mode-toggle")}
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
      {!isDemoMode && visibilityMode === "filtered" && (
        <FilteredModeSettings className="header-mode-settings" />
      )}
    </div>
  );
};
