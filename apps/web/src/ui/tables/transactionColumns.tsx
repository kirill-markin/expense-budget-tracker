import { type ReactElement } from "react";

import { cn } from "@/lib/cn";
import type { NumberFormat, DateFormat } from "@/lib/locale";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { EditableAmount } from "./EditableAmount";
import { EditableCategory } from "./EditableCategory";
import { EditableDateTime } from "./EditableDateTime";
import { EditableKind } from "./EditableKind";
import { EditableText } from "./EditableText";
import styles from "./TableUi.module.css";
import type { ColumnDef } from "./data-table/types";
import { formatAmount, formatDateTime } from "./format";

type FormatParams = Readonly<{
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  t: (key: string) => string;
}>;

type MaskClassGetter = (row: LedgerEntry) => string;

type TextCommitHandler = (
  entryId: string,
  newValue: string | null,
  oldValue: string | null,
) => void;

export const editableDateColumn = (
  getMaskClass: MaskClassGetter,
  onDateTimeCommit: (entryId: string, newTs: string, oldTs: string) => void,
): ColumnDef<LedgerEntry> => ({
  key: "date",
  header: "Date",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableDateTime
      key="date"
      entryId={row.entryId}
      currentValue={row.ts}
      maskClass={getMaskClass(row)}
      onDateTimeCommit={onDateTimeCommit}
    />
  ),
  rightAlign: false,
  sortKey: "ts",
});

export const editableAccountColumn = (
  getMaskClass: MaskClassGetter,
  onCommit: TextCommitHandler,
  hints: ReadonlyArray<string>,
): ColumnDef<LedgerEntry> => ({
  key: "account",
  header: "Account",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableText
      key="account"
      entryId={row.entryId}
      currentValue={row.accountId}
      maskClass={getMaskClass(row)}
      onCommit={onCommit}
      hints={hints}
      allowEmptyString={true}
    />
  ),
  rightAlign: false,
  sortKey: "accountId",
});

export const editableAmountColumn = (
  getMaskClass: MaskClassGetter,
  onAmountCommit: (entryId: string, newAmount: number, oldAmount: number) => void,
): ColumnDef<LedgerEntry> => ({
  key: "amount",
  header: "Amount",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableAmount
      key="amount"
      entryId={row.entryId}
      currentValue={row.amount}
      maskClass={getMaskClass(row)}
      onAmountCommit={onAmountCommit}
    />
  ),
  rightAlign: true,
  sortKey: "amount",
});

export const editableCurrencyColumn = (
  getMaskClass: MaskClassGetter,
  onCommit: TextCommitHandler,
  hints: ReadonlyArray<string>,
): ColumnDef<LedgerEntry> => ({
  key: "currency",
  header: "Currency",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableText
      key="currency"
      entryId={row.entryId}
      currentValue={row.currency}
      maskClass={getMaskClass(row)}
      onCommit={onCommit}
      hints={hints}
      allowEmptyString={true}
    />
  ),
  rightAlign: false,
  sortKey: "currency",
});

export const editableKindColumn = (
  getMaskClass: MaskClassGetter,
  onKindChange: (entryId: string, newKind: string, oldKind: string) => void,
): ColumnDef<LedgerEntry> => ({
  key: "kind",
  header: "Kind",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableKind
      key="kind"
      entry={row}
      maskClass={getMaskClass(row)}
      onKindChange={onKindChange}
    />
  ),
  rightAlign: false,
  sortKey: "kind",
});

export const editableCategoryColumn = (
  getMaskClass: MaskClassGetter,
  categories: ReadonlyArray<string>,
  onCategoryChange: (entryId: string, newCategory: string | null, oldCategory: string | null) => void,
): ColumnDef<LedgerEntry> => ({
  key: "category",
  header: "Category",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableCategory
      key="category"
      entry={row}
      categories={categories}
      maskClass={getMaskClass(row)}
      onCategoryChange={onCategoryChange}
    />
  ),
  rightAlign: false,
  sortKey: "category",
});

export const editableCounterpartyColumn = (
  getMaskClass: MaskClassGetter,
  onCommit: TextCommitHandler,
  hints: ReadonlyArray<string>,
): ColumnDef<LedgerEntry> => ({
  key: "counterparty",
  header: "Counterparty",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableText
      key="counterparty"
      entryId={row.entryId}
      currentValue={row.counterparty}
      maskClass={getMaskClass(row)}
      onCommit={onCommit}
      hints={hints}
    />
  ),
  rightAlign: false,
  sortKey: "counterparty",
});

export const editableNoteColumn = (
  getMaskClass: MaskClassGetter,
  onCommit: TextCommitHandler,
  hints: ReadonlyArray<string>,
): ColumnDef<LedgerEntry> => ({
  key: "note",
  header: "Note",
  renderCell: (row: LedgerEntry): ReactElement => (
    <EditableText
      key="note"
      entryId={row.entryId}
      currentValue={row.note}
      maskClass={getMaskClass(row)}
      onCommit={onCommit}
      cellClass={styles.cellNote}
      hints={hints}
    />
  ),
  rightAlign: false,
  sortKey: null,
});

export const editableDeleteColumn = (
  onDelete: (entryId: string) => void,
): ColumnDef<LedgerEntry> => ({
  key: "delete",
  header: "",
  renderCell: (row: LedgerEntry): ReactElement => (
    <span className={styles.cellDelete}>
      <button
        type="button"
        className={styles.deleteButton}
        onClick={() => onDelete(row.entryId)}
      >
        &#x2715;
      </button>
    </span>
  ),
  rightAlign: false,
  sortKey: null,
});

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

export const reportAmountColumn = (numberFormat: NumberFormat, reportingCurrency: string): ColumnDef<LedgerEntry> => ({
  key: "amountReport",
  header: reportingCurrency,
  renderCell: (row: LedgerEntry): ReactElement => (
    <td key="amountReport" className={cn(styles.cell, styles.cellRight)}>
      {row.amountReport !== null ? formatAmount(row.amountReport, numberFormat) : "\u2014"}
    </td>
  ),
  rightAlign: true,
  sortKey: null,
});
