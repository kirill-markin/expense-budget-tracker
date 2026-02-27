import { type ReactElement } from "react";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import type { ColumnDef } from "./data-table/types";
import { formatAmount, formatDateTime } from "./format";

export const buildTransactionColumns = (maskClass: string): Record<string, ColumnDef<LedgerEntry>> => ({
  date: {
    key: "date",
    header: "Date",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="date" className="txn-cell txn-cell-mono">{formatDateTime(row.ts)}</td>
    ),
    rightAlign: false,
    sortKey: "ts",
  },
  account: {
    key: "account",
    header: "Account",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="account" className={`txn-cell${maskClass}`}>{row.accountId}</td>
    ),
    rightAlign: false,
    sortKey: "accountId",
  },
  amount: {
    key: "amount",
    header: "Amount",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="amount" className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(row.amount)}</td>
    ),
    rightAlign: true,
    sortKey: "amount",
  },
  currency: {
    key: "currency",
    header: "Currency",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="currency" className={`txn-cell${maskClass}`}>{row.currency}</td>
    ),
    rightAlign: false,
    sortKey: "currency",
  },
  kind: {
    key: "kind",
    header: "Kind",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="kind" className={`txn-cell${maskClass}`}>{row.kind}</td>
    ),
    rightAlign: false,
    sortKey: "kind",
  },
  category: {
    key: "category",
    header: "Category",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="category" className={`txn-cell${maskClass}`}>{row.category ?? "\u2014"}</td>
    ),
    rightAlign: false,
    sortKey: "category",
  },
  counterparty: {
    key: "counterparty",
    header: "Counterparty",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="counterparty" className={`txn-cell${maskClass}`}>{row.counterparty ?? "\u2014"}</td>
    ),
    rightAlign: false,
    sortKey: "counterparty",
  },
  note: {
    key: "note",
    header: "Note",
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="note" className={`txn-cell txn-cell-note${maskClass}`}>{row.note ?? ""}</td>
    ),
    rightAlign: false,
    sortKey: null,
  },
});

export const usdColumn = (): ColumnDef<LedgerEntry> => ({
  key: "amountUsd",
  header: "USD",
  renderCell: (row: LedgerEntry): ReactElement => (
    <td key="amountUsd" className="txn-cell txn-cell-right">
      {row.amountUsd !== null ? formatAmount(row.amountUsd) : "\u2014"}
    </td>
  ),
  rightAlign: true,
  sortKey: null,
});
