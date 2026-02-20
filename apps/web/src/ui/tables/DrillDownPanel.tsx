"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";

export type DrillDownFilter = Readonly<{
  dateFrom: string;
  dateTo: string;
  direction: string;
  category: string | null;
}>;

type Props = Readonly<{
  filter: DrillDownFilter;
  categories: ReadonlyArray<string>;
  onClose: (dirty: boolean) => void;
}>;

type EditingCell = Readonly<{
  entryId: string;
  field: "category" | "note";
}>;

const PAGE_SIZE = 100;

const formatAmount = (value: number): string => {
  if (value === 0) return "0";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatDateTime = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    + " " + date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
};

const buildUrl = (
  filter: DrillDownFilter,
  limit: number,
  offset: number,
): string => {
  const params = new URLSearchParams();
  params.set("dateFrom", filter.dateFrom);
  params.set("dateTo", filter.dateTo);
  params.set("kind", filter.direction);
  if (filter.category !== null) {
    params.set("category", filter.category);
  }
  params.set("sortKey", "amountUsdAbs");
  params.set("sortDir", "desc");
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/api/transactions?${params.toString()}`;
};

const buildTitle = (filter: DrillDownFilter): string => {
  const category = filter.category ?? "All categories";
  const direction = filter.direction.charAt(0).toUpperCase() + filter.direction.slice(1);
  return `${direction} \u2014 ${category}`;
};

const buildSubtitle = (filter: DrillDownFilter): string => {
  return `${filter.dateFrom} \u2013 ${filter.dateTo}`;
};

const saveEntry = async (
  entryId: string,
  category: string | null,
  note: string | null,
): Promise<void> => {
  const response = await fetch("/api/transactions/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId, category, note }),
  });
  if (!response.ok) {
    throw new Error(`Update failed: ${response.status} ${await response.text()}`);
  }
};

export const DrillDownPanel = (props: Props): ReactElement => {
  const { filter, categories, onClose } = props;

  const [entries, setEntries] = useState<ReadonlyArray<LedgerEntry>>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchIdRef = useRef<number>(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dirtyRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const newWidth = window.innerWidth - e.clientX;
      const clamped = Math.max(320, Math.min(newWidth, window.innerWidth * 0.95));
      setPanelWidth(clamped);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  const fetchPage = useCallback(async (
    offset: number,
    append: boolean,
    currentFetchId: number,
  ): Promise<void> => {
    const url = buildUrl(filter, PAGE_SIZE, offset);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const page: TransactionsPage = await response.json();

    if (fetchIdRef.current !== currentFetchId) return;

    if (append) {
      setEntries((prev) => [...prev, ...page.entries]);
    } else {
      setEntries(page.entries);
    }
    setTotal(page.total);
  }, [filter]);

  useEffect(() => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    setEntries([]);
    setTotal(0);
    setEditingCell(null);

    fetchPage(0, false, fetchId)
      .catch((err: unknown) => {
        if (fetchIdRef.current !== fetchId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (fetchIdRef.current !== fetchId) return;
        setLoading(false);
      });
  }, [fetchPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (intersections) => {
        if (!intersections[0].isIntersecting) return;
        if (loadingMore || loading) return;
        if (entries.length >= total) return;

        const fetchId = fetchIdRef.current;
        setLoadingMore(true);
        fetchPage(entries.length, true, fetchId)
          .catch((err: unknown) => {
            if (fetchIdRef.current !== fetchId) return;
            setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            if (fetchIdRef.current !== fetchId) return;
            setLoadingMore(false);
          });
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [entries.length, total, loading, loadingMore, fetchPage]);

  const closePanel = useCallback((): void => {
    onClose(dirtyRef.current);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (editingCell !== null) {
          setEditingCell(null);
        } else {
          closePanel();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePanel, editingCell]);

  useEffect(() => {
    if (editingCell !== null && inputRef.current !== null) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  const startEditing = (entryId: string, field: "category" | "note", currentValue: string | null): void => {
    setEditingCell({ entryId, field });
    setEditValue(currentValue ?? "");
  };

  const commitEdit = (entryId: string, field: "category" | "note"): void => {
    const entry = entries.find((e) => e.entryId === entryId);
    if (entry === undefined) return;

    const trimmed = editValue.trim();
    const newValue = trimmed.length > 0 ? trimmed : null;
    const oldValue = field === "category" ? entry.category : entry.note;

    setEditingCell(null);

    if (newValue === oldValue) return;

    const newCategory = field === "category" ? newValue : entry.category;
    const newNote = field === "note" ? newValue : entry.note;

    setEntries((prev) =>
      prev.map((e) =>
        e.entryId === entryId
          ? { ...e, category: newCategory, note: newNote }
          : e,
      ),
    );

    saveEntry(entryId, newCategory, newNote).catch((err: unknown) => {
      setEntries((prev) =>
        prev.map((e) =>
          e.entryId === entryId
            ? { ...e, [field]: oldValue }
            : e,
        ),
      );
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, entryId: string, field: "category" | "note"): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(entryId, field);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditingCell(null);
    }
  };

  const isEditing = (entryId: string, field: "category" | "note"): boolean =>
    editingCell !== null && editingCell.entryId === entryId && editingCell.field === field;

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>, entryId: string): void => {
    const entry = entries.find((en) => en.entryId === entryId);
    if (entry === undefined) return;

    const newValue = e.target.value.length > 0 ? e.target.value : null;
    const oldValue = entry.category;

    if (newValue === oldValue) return;

    dirtyRef.current = true;

    setEntries((prev) =>
      prev.map((en) =>
        en.entryId === entryId ? { ...en, category: newValue } : en,
      ),
    );

    saveEntry(entryId, newValue, entry.note).catch((err: unknown) => {
      setEntries((prev) =>
        prev.map((en) =>
          en.entryId === entryId ? { ...en, category: oldValue } : en,
        ),
      );
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  const renderCategoryCell = (entry: LedgerEntry): ReactElement => (
    <td className="txn-cell">
      <select
        className="drilldown-input"
        value={entry.category ?? ""}
        onChange={(e) => handleCategoryChange(e, entry.entryId)}
      >
        <option value="">{"\u2014"}</option>
        {categories.map((cat) => (
          <option key={cat} value={cat}>{cat}</option>
        ))}
      </select>
    </td>
  );

  const renderNoteCell = (entry: LedgerEntry): ReactElement => {
    if (isEditing(entry.entryId, "note")) {
      return (
        <td className="txn-cell txn-cell-note">
          <input
            ref={inputRef}
            className="drilldown-input"
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => commitEdit(entry.entryId, "note")}
            onKeyDown={(e) => handleInputKeyDown(e, entry.entryId, "note")}
          />
        </td>
      );
    }

    return (
      <td
        className="txn-cell txn-cell-note drilldown-editable"
        onClick={() => startEditing(entry.entryId, "note", entry.note)}
      >
        {entry.note ?? "\u2014"}
      </td>
    );
  };

  return (
    <>
      <div className="drilldown-overlay" onClick={closePanel} />
      <div className="drilldown-panel" ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={`drilldown-resize-handle${isDragging ? " dragging" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className="drilldown-header">
          <div>
            <div className="drilldown-title">{buildTitle(filter)}</div>
            <div className="drilldown-subtitle">{buildSubtitle(filter)}</div>
          </div>
          <button className="drilldown-close" type="button" onClick={closePanel}>
            &times;
          </button>
        </div>

        {!loading && (
          <div className="drilldown-count">
            {total} {total === 1 ? "entry" : "entries"}
          </div>
        )}

        {error !== null && (
          <div className="budget-alert" style={{ margin: "8px 16px" }}>
            <strong>Failed to load transactions</strong>
            <span>{error}</span>
          </div>
        )}

        <div className="drilldown-body">
          <table className="txn-table">
            <thead>
              <tr>
                <th className="txn-th">Date</th>
                <th className="txn-th">Account</th>
                <th className="txn-th txn-th-right">Amount</th>
                <th className="txn-th">Currency</th>
                <th className="txn-th txn-th-right">USD</th>
                <th className="txn-th">Kind</th>
                <th className="txn-th">Category</th>
                <th className="txn-th">Counterparty</th>
                <th className="txn-th">Note</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, idx) => (
                <tr key={`${e.entryId}-${idx}`} className="txn-row">
                  <td className="txn-cell txn-cell-mono">{formatDateTime(e.ts)}</td>
                  <td className="txn-cell">{e.accountId}</td>
                  <td className="txn-cell txn-cell-right">{formatAmount(e.amount)}</td>
                  <td className="txn-cell">{e.currency}</td>
                  <td className="txn-cell txn-cell-right">{e.amountUsd !== null ? formatAmount(e.amountUsd) : "\u2014"}</td>
                  <td className="txn-cell">{e.kind}</td>
                  {renderCategoryCell(e)}
                  <td className="txn-cell">{e.counterparty ?? "\u2014"}</td>
                  {renderNoteCell(e)}
                </tr>
              ))}
              {!loading && entries.length === 0 && (
                <tr>
                  <td className="txn-cell" colSpan={9} style={{ textAlign: "center", color: "var(--muted)" }}>
                    No entries found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div ref={sentinelRef} className="txn-scroll-sentinel">
            {loading && <span className="loading-indicator">Loading<span className="loading-dots" /></span>}
            {loadingMore && <span className="loading-indicator">Loading more<span className="loading-dots" /></span>}
          </div>
        </div>
      </div>
    </>
  );
};
