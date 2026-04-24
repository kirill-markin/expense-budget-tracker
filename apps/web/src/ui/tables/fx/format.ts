import type { NumberFormat } from "@/lib/locale";

import { NUMBER_FORMAT_LOCALE } from "@/ui/tables/shared/format";

/**
 * Formats an FX adjustment for display.
 * Negates the internal value so that visually:
 *   positive display = book overestimated (FX loss, shown red)
 *   negative display = book underestimated (FX gain)
 * Always shows an explicit +/- prefix.
 */
export const formatFxAmount = (value: number, numberFormat: NumberFormat): string => {
  const display = Math.round(-value);
  if (display === 0) return "0";
  const prefix = display > 0 ? "+" : "";
  return prefix + display.toLocaleString(NUMBER_FORMAT_LOCALE[numberFormat]);
};
