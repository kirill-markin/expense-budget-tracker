"use client";

import Link from "next/link";
import type { ReactElement } from "react";

import { useFilteredMode } from "@/ui/FilteredModeProvider";

export const FilteredBanner = (): ReactElement | null => {
  const { visibilityMode } = useFilteredMode();

  if (visibilityMode !== "filtered") return null;

  return (
    <div className="demo-banner">
      Filtered mode<span className="demo-banner-detail"> — only selected categories are visible</span>
      <Link
        href="/settings"
        className="demo-banner-detail data-mask-seg"
        style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8, textDecoration: "none" }}
      >
        Settings
      </Link>
    </div>
  );
};
