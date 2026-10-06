/**
 * Hover reasons for values that silently dropped entries because their currency
 * had no exchange rate for that day: the value is incomplete, not over plan.
 * `formatReason` turns the currency list into the localized sentence.
 */

export const buildUnconvertibleCurrenciesTitle = (
  currencies: ReadonlyArray<string>,
  formatReason: (currencies: string) => string,
): string | null => (
  currencies.length === 0 ? null : formatReason([...currencies].sort().join(", "))
);

/**
 * Reason for a cell that covers one month (`(candidate) => candidate === month`),
 * a year (month prefix) or everything up to a month (cumulative Balance): the
 * union of the unconvertible currencies of every month the cell includes.
 */
export const buildUnconvertibleMonthsTitle = (
  currenciesByMonth: ReadonlyMap<string, ReadonlyArray<string>>,
  includesMonth: (month: string) => boolean,
  formatReason: (currencies: string) => string,
): string | null => {
  const currencies = new Set<string>();
  for (const [month, monthCurrencies] of currenciesByMonth) {
    if (!includesMonth(month)) {
      continue;
    }
    for (const currency of monthCurrencies) {
      currencies.add(currency);
    }
  }
  return buildUnconvertibleCurrenciesTitle([...currencies], formatReason);
};

/**
 * Both reason builders of one row or section, sharing its month map, localized
 * `formatReason` and masking gate: each returns `null` for a trusted value and
 * for a masked one, because a hidden amount must not explain itself.
 *
 * Year totals come from their own full-year fetch, so their reason comes from
 * that fetch too: the month map only covers the horizontally loaded range.
 */
export const createUnconvertibleTitleBuilders = (
  params: Readonly<{
    currenciesByMonth: ReadonlyMap<string, ReadonlyArray<string>>;
    formatReason: (currencies: string) => string;
    showData: boolean;
  }>,
): Readonly<{
  monthsTitle: (isTainted: boolean, includesMonth: (month: string) => boolean) => string | null;
  currenciesTitle: (isTainted: boolean, currencies: ReadonlyArray<string>) => string | null;
}> => {
  const { currenciesByMonth, formatReason, showData } = params;

  return {
    monthsTitle: (isTainted: boolean, includesMonth: (month: string) => boolean): string | null => (
      isTainted && showData
        ? buildUnconvertibleMonthsTitle(currenciesByMonth, includesMonth, formatReason)
        : null
    ),
    currenciesTitle: (isTainted: boolean, currencies: ReadonlyArray<string>): string | null => (
      isTainted && showData
        ? buildUnconvertibleCurrenciesTitle(currencies, formatReason)
        : null
    ),
  };
};
