"use client";

import type { ReactElement } from "react";

import type { MaskLevel } from "@/lib/dataMask";

type Props = Readonly<{
  maskLevel: MaskLevel;
  setMaskLevel: (level: MaskLevel) => void;
  showSpendOption: boolean;
}>;

export const DataMaskToggle = (props: Props): ReactElement => {
  const { maskLevel, setMaskLevel, showSpendOption } = props;

  return (
    <div className="data-mask-segmented">
      <button
        className={`data-mask-seg${maskLevel === "hidden" ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => setMaskLevel("hidden")}
      >
        Hidden
      </button>
      {showSpendOption && (
        <button
          className={`data-mask-seg${maskLevel === "spend-only" ? " data-mask-seg-active" : ""}`}
          type="button"
          onClick={() => setMaskLevel("spend-only")}
        >
          Spend
        </button>
      )}
      <button
        className={`data-mask-seg${maskLevel === "all" ? " data-mask-seg-active" : ""}`}
        type="button"
        onClick={() => setMaskLevel("all")}
      >
        All
      </button>
    </div>
  );
};
