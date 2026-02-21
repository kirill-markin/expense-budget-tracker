"use client";

import type { ReactElement } from "react";

type Props = Readonly<{
  isDemoMode: boolean;
}>;

export const DemoModeToggle = (props: Props): ReactElement => {
  const { isDemoMode } = props;

  const switchTo = (demo: boolean): void => {
    if (demo === isDemoMode) return;
    if (demo) {
      document.cookie = "demo=true; path=/; max-age=31536000";
    } else {
      document.cookie = "demo=; path=/; max-age=0";
    }
    window.location.reload();
  };

  return (
    <div className="data-mask-segmented">
      <button
        className={`data-mask-seg${!isDemoMode ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => switchTo(false)}
      >
        Real
      </button>
      <button
        className={`data-mask-seg${isDemoMode ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => switchTo(true)}
      >
        Demo
      </button>
    </div>
  );
};
