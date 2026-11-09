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
    <div className="demo-banner filtered-banner">
      <span className="filtered-banner-status">
        {t("filtered.banner")}<span className="demo-banner-detail"> {t("filtered.bannerDetail")}</span>
      </span>
      <FilteredModeSettings className="filtered-banner-settings" />
    </div>
  );
};

export const FilteredModeSettings = ({ className }: Readonly<{ className: string }>): ReactElement => {
  const { t } = useTranslation();

  return (
    <Link
      href="/settings"
      className={className}
      aria-label={t("filtered.settingsLink")}
      title={t("filtered.settingsLink")}
    >
      <span className="filtered-banner-settings-label">{t("filtered.settingsLink")}</span>
      <svg className="filtered-banner-settings-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </Link>
  );
};
