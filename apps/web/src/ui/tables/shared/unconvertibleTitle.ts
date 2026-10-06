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
