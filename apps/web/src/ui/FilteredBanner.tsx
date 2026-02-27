"use client";

import { useState, type ReactElement } from "react";

import { useFilteredMode } from "@/ui/FilteredModeProvider";

export const FilteredBanner = (): ReactElement | null => {
  const { visibilityMode, allCategories, allowedCategories, setAllowedCategories } = useFilteredMode();
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);

  if (visibilityMode !== "filtered") return null;

  const toggleCategory = (cat: string): void => {
    const next = new Set(allowedCategories);
    if (next.has(cat)) {
      next.delete(cat);
    } else {
      next.add(cat);
    }
    setAllowedCategories(next);
  };

  const selectAll = (): void => {
    setAllowedCategories(new Set(allCategories));
  };

  const selectNone = (): void => {
    setAllowedCategories(new Set());
  };

  return (
    <>
      <div className="demo-banner">
        Filtered mode — only selected categories are visible
        {" "}
        <button
          type="button"
          className="data-mask-seg"
          style={{ fontSize: 11, padding: "1px 8px", marginLeft: 8 }}
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          {pickerOpen ? "Close" : "Settings"}
        </button>
      </div>
      {pickerOpen && (
        <div className="filtered-category-picker">
          <div className="filtered-picker-actions">
            <button type="button" className="data-mask-seg" onClick={selectAll}>Select all</button>
            <button type="button" className="data-mask-seg" onClick={selectNone}>Select none</button>
          </div>
          {allCategories.map((cat) => (
            <label key={cat} className="filtered-picker-item">
              <input
                type="checkbox"
                checked={allowedCategories.has(cat)}
                onChange={() => toggleCategory(cat)}
              />
              {cat}
            </label>
          ))}
        </div>
      )}
    </>
  );
};
