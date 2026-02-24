/**
 * Available reporting currencies resolver.
 *
 * Queries exchange_rates for all distinct base currencies that have at least
 * one rate stored, then adds USD (the implicit quote currency).
 * The result is the set of currencies a workspace can use for reporting.
 */
import { queryAs } from "@/server/db";

/** Returns sorted array of currency codes that have exchange rates available. */
export const getAvailableCurrencies = async (userId: string, workspaceId: string): Promise<ReadonlyArray<string>> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT DISTINCT base_currency FROM exchange_rates ORDER BY base_currency",
    [],
  );
  const currencies = (result.rows as ReadonlyArray<{ base_currency: string }>).map((r) => r.base_currency);
  if (!currencies.includes("USD")) {
    currencies.push("USD");
  }
  return currencies.toSorted();
};
