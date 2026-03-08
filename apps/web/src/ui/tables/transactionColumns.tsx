import { type ReactElement } from "react";

import { cn } from "@/lib/cn";
import type { NumberFormat, DateFormat } from "@/lib/locale";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

import styles from "./TableUi.module.css";
import type { ColumnDef } from "./data-table/types";
import { formatAmount, formatDateTime } from "./format";

type FormatParams = Readonly<{
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  t: (key: string) => string;
}>;

export const buildTransactionColumns = (maskClass: string, fmt: FormatParams): Record<string, ColumnDef<LedgerEntry>> => ({
  date: {
    key: "date",
    header: fmt.t("table.date"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="date" className={cn(styles.cell, styles.cellMono)}>{formatDateTime(row.ts, fmt.dateFormat)}</td>
    ),
    rightAlign: false,
    sortKey: "ts",
  },
  account: {
    key: "account",
    header: fmt.t("table.account"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="account" className={cn(styles.cell, maskClass)}>{row.accountId}</td>
    ),
    rightAlign: false,
    sortKey: "accountId",
  },
  amount: {
    key: "amount",
    header: fmt.t("table.amount"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="amount" className={cn(styles.cell, styles.cellRight, maskClass)}>{formatAmount(row.amount, fmt.numberFormat)}</td>
    ),
    rightAlign: true,
    sortKey: "amount",
  },
  currency: {
    key: "currency",
    header: fmt.t("table.currency"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="currency" className={cn(styles.cell, maskClass)}>{row.currency}</td>
    ),
    rightAlign: false,
    sortKey: "currency",
  },
  kind: {
    key: "kind",
    header: fmt.t("table.kind"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="kind" className={cn(styles.cell, maskClass)}>{row.kind}</td>
    ),
    rightAlign: false,
    sortKey: "kind",
  },
  category: {
    key: "category",
    header: fmt.t("table.category"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="category" className={cn(styles.cell, maskClass)}>{row.category ?? "\u2014"}</td>
    ),
    rightAlign: false,
    sortKey: "category",
  },
  counterparty: {
    key: "counterparty",
    header: fmt.t("table.counterparty"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="counterparty" className={cn(styles.cell, maskClass)}>{row.counterparty ?? "\u2014"}</td>
    ),
    rightAlign: false,
    sortKey: "counterparty",
  },
  note: {
    key: "note",
    header: fmt.t("table.note"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="note" className={cn(styles.cell, styles.cellNote, maskClass)}>{row.note ?? ""}</td>
    ),
    rightAlign: false,
    sortKey: null,
  },
});

export const usdColumn = (numberFormat: NumberFormat): ColumnDef<LedgerEntry> => ({
  key: "amountUsd",
  header: "USD",
  renderCell: (row: LedgerEntry): ReactElement => (
    <td key="amountUsd" className={cn(styles.cell, styles.cellRight)}>
      {row.amountUsd !== null ? formatAmount(row.amountUsd, numberFormat) : "\u2014"}
    </td>
  ),
  rightAlign: true,
  sortKey: null,
});
