import { type ReactElement } from "react";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

const KIND_OPTIONS: ReadonlyArray<string> = ["income", "spend", "transfer"];

type Props = Readonly<{
  entry: LedgerEntry;
  maskClass: string;
  onKindChange: (entryId: string, newKind: string, oldKind: string) => void;
}>;

export const EditableKind = (props: Props): ReactElement => {
  const { entry, maskClass, onKindChange } = props;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const newValue = e.target.value;
    if (newValue === entry.kind) return;
    onKindChange(entry.entryId, newValue, entry.kind);
  };

  if (maskClass.length > 0) {
    return (
      <td className={`txn-cell${maskClass}`}>{entry.kind}</td>
    );
  }

  return (
    <td className="txn-cell">
      <select
        className="drilldown-input"
        value={entry.kind}
        onChange={handleChange}
      >
        {KIND_OPTIONS.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
    </td>
  );
};
