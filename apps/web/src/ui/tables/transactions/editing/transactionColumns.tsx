import { type ReactElement } from "react";

import { cn } from "@/lib/cn";
import type { NumberFormat, DateFormat } from "@/lib/locale";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { EditableAmount } from "@/ui/tables/editable/EditableAmount";
import { EditableCategory } from "@/ui/tables/editable/EditableCategory";
import { EditableDateTime } from "@/ui/tables/editable/EditableDateTime";
import { EditableKind } from "@/ui/tables/editable/EditableKind";
import { EditableNote } from "@/ui/tables/editable/EditableNote";
import { EditableText } from "@/ui/tables/editable/EditableText";
import type { ColumnDef } from "@/ui/tables/shared/data-table/types";
import { formatAmount, formatDateTime } from "@/ui/tables/shared/format";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import { isTransactionCopyAvailable } from "../transactionClipboard";
import transactionStyles from "../TransactionsTable.module.css";

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

export const transactionCopyColumn = (
  effectiveAllowlist: ReadonlySet<string> | null,
  pendingEntryIds: ReadonlySet<string>,
  onCopy: (entry: LedgerEntry) => Promise<void>,
  label: string,
): ColumnDef<LedgerEntry> => ({
  key: "copy",
  header: "",
  renderCell: (row: LedgerEntry): ReactElement => (
    <td key="copy" className={cn(tableStyles.cell, transactionStyles.cellCopy)}>
      {isTransactionCopyAvailable(row, effectiveAllowlist, pendingEntryIds) && (
        <button
          type="button"
          className={transactionStyles.copyButton}
          aria-label={label}
          title={label}
          data-testid={`transaction-copy-${row.entryId}`}
          onClick={() => { void onCopy(row); }}
        >
          <svg
            className={transactionStyles.copyIcon}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="5.25" y="5.25" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.75 3.75V3A1.25 1.25 0 0 0 9.5 1.75H3A1.25 1.25 0 0 0 1.75 3v6.5A1.25 1.25 0 0 0 3 10.75h.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </td>
  ),
  rightAlign: false,
  sortKey: null,
});

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
    <EditableNote
      key="note"
      entryId={row.entryId}
      currentValue={row.note}
      maskClass={getMaskClass(row)}
      onCommit={onCommit}
      cellClass={transactionStyles.cellNote}
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
    <td key="delete" className={cn(tableStyles.cell, transactionStyles.cellDelete)}>
      <button
        type="button"
        className={transactionStyles.deleteButton}
        onClick={() => onDelete(row.entryId)}
      >
        &#x2715;
      </button>
    </td>
  ),
  rightAlign: false,
  sortKey: null,
});

export const buildTransactionColumns = (maskClass: string, fmt: FormatParams): Record<string, ColumnDef<LedgerEntry>> => ({
  date: {
    key: "date",
    header: fmt.t("table.date"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="date" className={cn(tableStyles.cell, tableStyles.cellMono)}>{formatDateTime(row.ts, fmt.dateFormat)}</td>
    ),
    rightAlign: false,
    sortKey: "ts",
  },
  account: {
    key: "account",
    header: fmt.t("table.account"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="account" className={cn(tableStyles.cell, maskClass)}>{row.accountId}</td>
    ),
    rightAlign: false,
    sortKey: "accountId",
  },
  amount: {
    key: "amount",
    header: fmt.t("table.amount"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="amount" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.amount, fmt.numberFormat)}</td>
    ),
    rightAlign: true,
    sortKey: "amount",
  },
  currency: {
    key: "currency",
    header: fmt.t("table.currency"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="currency" className={cn(tableStyles.cell, maskClass)}>{row.currency}</td>
    ),
    rightAlign: false,
    sortKey: "currency",
  },
  kind: {
    key: "kind",
    header: fmt.t("table.kind"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="kind" className={cn(tableStyles.cell, maskClass)}>{row.kind}</td>
    ),
    rightAlign: false,
    sortKey: "kind",
  },
  category: {
    key: "category",
    header: fmt.t("table.category"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="category" className={cn(tableStyles.cell, maskClass)}>{row.category ?? "\u2014"}</td>
    ),
    rightAlign: false,
    sortKey: "category",
  },
  counterparty: {
    key: "counterparty",
    header: fmt.t("table.counterparty"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="counterparty" className={cn(tableStyles.cell, maskClass)}>{row.counterparty ?? "\u2014"}</td>
    ),
    rightAlign: false,
    sortKey: "counterparty",
  },
  note: {
    key: "note",
    header: fmt.t("table.note"),
    renderCell: (row: LedgerEntry): ReactElement => (
      <td key="note" className={cn(tableStyles.cell, transactionStyles.cellNote, maskClass)}>
        <span className={tableStyles.cellSingleLinePreview}>
          {row.note === null || row.note.length === 0 ? "\u2014" : row.note}
        </span>
      </td>
    ),
    rightAlign: false,
    sortKey: null,
  },
});

export const reportAmountColumn = (numberFormat: NumberFormat, reportingCurrency: string): ColumnDef<LedgerEntry> => ({
  key: "amountReport",
  header: reportingCurrency,
  renderCell: (row: LedgerEntry): ReactElement => (
    <td key="amountReport" className={cn(tableStyles.cell, tableStyles.cellRight)}>
      {row.amountReport !== null ? formatAmount(row.amountReport, numberFormat) : "\u2014"}
    </td>
  ),
  rightAlign: true,
  sortKey: null,
});
