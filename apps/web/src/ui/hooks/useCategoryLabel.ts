import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { formatCategoryLabel } from "@/i18n/demoLabels";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

export const useCategoryLabel = (): ((category: string) => string) => {
  const { isDemoMode } = useFilteredMode();
  const { t } = useTranslation();
  return useCallback((category: string): string => formatCategoryLabel(category, isDemoMode, t), [isDemoMode, t]);
};
