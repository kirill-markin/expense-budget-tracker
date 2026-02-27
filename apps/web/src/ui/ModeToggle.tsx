"use client";

import type { ReactElement } from "react";

import { useFilteredMode } from "@/ui/FilteredModeProvider";

type Props = Readonly<{
  isDemoMode: boolean;
}>;

export const ModeToggle = (props: Props): ReactElement => {
  const { isDemoMode } = props;
  const { visibilityMode, setVisibilityMode } = useFilteredMode();

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
    <div className="data-mask-segmented">
      <button
        className={`data-mask-seg${activeMode === "all" ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => switchTo("all")}
      >
        All
      </button>
      <button
        className={`data-mask-seg${activeMode === "filtered" ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => switchTo("filtered")}
      >
        Filtered
      </button>
      <button
        className={`data-mask-seg${activeMode === "demo" ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => switchTo("demo")}
      >
        Demo
      </button>
    </div>
  );
};
