"use client";

import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

type Props = Readonly<{
  initialCurrency: string;
}>;

export const CurrencySelector = (props: Props): ReactElement => {
  const { initialCurrency } = props;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [value, setValue] = useState<string>(initialCurrency);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback((): void => {
    setIsOpen((prev) => !prev);
    setError(null);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        menuRef.current !== null && !menuRef.current.contains(target) &&
        buttonRef.current !== null && !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
        setValue(initialCurrency);
        setError(null);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, initialCurrency]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setValue(initialCurrency);
        setError(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, initialCurrency]);

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(trimmed)) {
      setError("Enter a 3-letter currency code");
      return;
    }
    if (trimmed === initialCurrency) {
      setIsOpen(false);
      return;
    }
    setSaving(true);
    setError(null);
    const response = await fetch("/api/workspace-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportingCurrency: trimmed }),
    });
    if (!response.ok) {
      const text = await response.text();
      setError(text);
      setSaving(false);
      return;
    }
    window.location.reload();
  }, [value, initialCurrency]);

  return (
    <div className="currency-selector-wrap">
      <button
        ref={buttonRef}
        className="currency-selector-btn"
        type="button"
        onClick={toggle}
        title="Reporting currency"
      >
        {initialCurrency}
      </button>
      {isOpen && (
        <div ref={menuRef} className="currency-selector-dropdown">
          <input
            type="text"
            className="currency-selector-input"
            value={value}
            onChange={(e) => setValue(e.target.value.toUpperCase())}
            maxLength={3}
            autoFocus
          />
          <button
            className="currency-selector-save"
            type="button"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "..." : "Save"}
          </button>
          {error !== null && <div className="currency-selector-error">{error}</div>}
        </div>
      )}
    </div>
  );
};
