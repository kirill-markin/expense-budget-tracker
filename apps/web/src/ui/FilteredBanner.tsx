"use client";

import Link from "next/link";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { useFilteredMode } from "@/ui/FilteredModeProvider";

export const FilteredBanner = (): ReactElement | null => {
  const { visibilityMode } = useFilteredMode();
  const { t } = useTranslation();

  if (visibilityMode !== "filtered") return null;

  return (
    <div className="demo-banner">
      {t("filtered.banner")}<span className="demo-banner-detail"> {t("filtered.bannerDetail")}</span>
      <Link
        href="/settings"
        className="demo-banner-detail data-mask-seg"
        style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8, textDecoration: "none" }}
      >
        {t("filtered.settingsLink")}
      </Link>
    </div>
  );
};
