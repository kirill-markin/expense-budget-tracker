import { type ReactElement } from "react";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

type Props = Readonly<{
  entry: LedgerEntry;
  categories: ReadonlyArray<string>;
  maskClass: string;
  onCategoryChange: (entryId: string, newCategory: string | null, oldCategory: string | null) => void;
}>;

export const EditableCategory = (props: Props): ReactElement => {
  const { entry, categories, maskClass, onCategoryChange } = props;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const newValue = e.target.value.length > 0 ? e.target.value : null;
    if (newValue === entry.category) return;
    onCategoryChange(entry.entryId, newValue, entry.category);
  };

  if (maskClass.length > 0) {
    return (
      <td className={`txn-cell${maskClass}`}>{entry.category ?? "\u2014"}</td>
    );
  }

  return (
    <td className="txn-cell">
      <select
        className="drilldown-input"
        value={entry.category ?? ""}
        onChange={handleChange}
      >
        <option value="">{"\u2014"}</option>
        {categories.map((cat) => (
          <option key={cat} value={cat}>{cat}</option>
        ))}
      </select>
    </td>
  );
};
