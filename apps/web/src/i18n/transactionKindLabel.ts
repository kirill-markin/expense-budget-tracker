import type { TransactionKind } from "@/server/transactions/getTransactions";

const TRANSACTION_KIND_LABEL_KEYS: Readonly<Record<TransactionKind, string>> = {
  income: "budget.directionIncome",
  spend: "budget.directionSpend",
  transfer: "budget.directionTransfer",
};

export const TRANSACTION_KIND_LABEL_VALUES: ReadonlyArray<string> = Object.keys(TRANSACTION_KIND_LABEL_KEYS);

export const transactionKindLabel = (kind: string, t: (key: string) => string): string =>
  Object.hasOwn(TRANSACTION_KIND_LABEL_KEYS, kind) ? t(TRANSACTION_KIND_LABEL_KEYS[kind as TransactionKind]) : kind;
