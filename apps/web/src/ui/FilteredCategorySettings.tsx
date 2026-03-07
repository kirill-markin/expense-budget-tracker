"use client";

import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchWithCsrf } from "@/lib/csrf";

type Props = Readonly<{
  filteredCategories: ReadonlyArray<string> | null;
  allCategories: ReadonlyArray<string>;
}>;

export const FilteredCategorySettings = (props: Props): ReactElement => {
  const { filteredCategories, allCategories } = props;
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set(filteredCategories ?? []),
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  const initial = new Set(filteredCategories ?? []);
  const dirty = selected.size !== initial.size || [...selected].some((c) => !initial.has(c));

  const toggle = (cat: string): void => {
    const next = new Set(selected);
    if (next.has(cat)) {
      next.delete(cat);
    } else {
      next.add(cat);
    }
    setSelected(next);
    setSaved(false);
  };

  const selectAll = (): void => {
    setSelected(new Set(allCategories));
    setSaved(false);
  };

  const clearAll = (): void => {
    setSelected(new Set());
    setSaved(false);
  };

  const handleSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const payload = selected.size === 0 ? null : [...selected];
    const response = await fetchWithCsrf("/api/workspace-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filteredCategories: payload }),
    });
    if (!response.ok) {
      const text = await response.text();
      setError(text);
      setSaving(false);
      return;
    }
    setSaving(false);
    setSaved(true);
  }, [selected]);

  return (
    <div className="settings-form">
      <div className="settings-row settings-row-wide">
        <label className="settings-label">
          {t("settings.filteredCategoriesLabel")}
        </label>
        <p className="settings-label" style={{ margin: 0 }}>
          {t("settings.filteredCategoriesHint")}
        </p>
        <div className="filtered-cats-actions">
          <button type="button" className="data-mask-seg" onClick={selectAll}>{t("settings.selectAll")}</button>
          <button type="button" className="data-mask-seg" onClick={clearAll}>{t("settings.clear")}</button>
        </div>
        <div className="filtered-cats-list">
          {allCategories.map((cat) => (
            <label key={cat} className="filtered-cats-item">
              <input
                type="checkbox"
                checked={selected.has(cat)}
                onChange={() => toggle(cat)}
              />
              {cat}
            </label>
          ))}
          {allCategories.length === 0 && (
            <span className="settings-label">{t("settings.noCategories")}</span>
          )}
        </div>
        <div className="settings-control">
          <button
            className="settings-save"
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
        {error !== null && <div className="settings-error">{error}</div>}
        {saved && <div className="settings-saved">{t("common.saved")}</div>}
      </div>
    </div>
  );
};
