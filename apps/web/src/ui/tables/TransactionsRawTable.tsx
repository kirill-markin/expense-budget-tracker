"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AccountOption, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";
import { DataMaskToggle } from "@/ui/DataMaskToggle";
import { useDataMask } from "@/ui/hooks/useDataMask";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountOption>;
}>;

type SortDir = "asc" | "desc";

type SortKey = "ts" | "accountId" | "amount" | "currency" | "kind" | "category" | "counterparty";

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

const toDateInputValue = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const sortIndicator = (active: boolean, dir: SortDir): string => {
  if (!active) return "";
  return dir === "asc" ? " \u2191" : " \u2193";
};

const buildUrl = (
  dateFrom: string,
  dateTo: string,
  selectedAccount: string,
  sortKey: SortKey,
  sortDir: SortDir,
  limit: number,
  offset: number,
): string => {
  const params = new URLSearchParams();
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (selectedAccount) params.set("accountId", selectedAccount);
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/api/transactions?${params.toString()}`;
};

export const TransactionsRawTable = (props: Props): ReactElement => {
  const { accounts } = props;
  const { maskLevel, setMaskLevel } = useDataMask();
  const maskClass = maskLevel === "all" ? "" : " data-masked";

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [dateFrom, setDateFrom] = useState<string>(toDateInputValue(ninetyDaysAgo));
  const [dateTo, setDateTo] = useState<string>(toDateInputValue(now));
  const [selectedAccount, setSelectedAccount] = useState<string>("");

  const [sortKey, setSortKey] = useState<SortKey>("ts");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [entries, setEntries] = useState<ReadonlyArray<LedgerEntry>>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchIdRef = useRef<number>(0);

  const fetchPage = useCallback(async (
    offset: number,
    append: boolean,
    currentFetchId: number,
  ): Promise<void> => {
    const url = buildUrl(dateFrom, dateTo, selectedAccount, sortKey, sortDir, PAGE_SIZE, offset);
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
  }, [dateFrom, dateTo, selectedAccount, sortKey, sortDir]);

  useEffect(() => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    setEntries([]);
    setTotal(0);

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

  const toggleSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "amount" ? "desc" : "asc");
    }
  };

  const th = (label: string, key: SortKey, rightAlign: boolean): ReactElement => (
    <th
      className={`txn-th txn-th-sortable${rightAlign ? " txn-th-right" : ""}`}
      onClick={() => toggleSort(key)}
    >
      {label}{sortIndicator(sortKey === key, sortDir)}
    </th>
  );

  return (
    <>
      <div className="txn-filters">
        <label className="txn-filter-label">
          From
          <input
            type="date"
            className="txn-filter-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          To
          <input
            type="date"
            className="txn-filter-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          Account
          <select
            className="txn-filter-input"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">All</option>
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>{a.accountId}</option>
            ))}
          </select>
        </label>
        {!loading && (
          <span className="txn-filter-count">
            {entries.length} of {total} entries
          </span>
        )}
      </div>

      <div className="data-mask-toggle">
        <DataMaskToggle maskLevel={maskLevel} setMaskLevel={setMaskLevel} showSpendOption={true} />
      </div>

      {error !== null && (
        <div className="budget-alert">
          <strong>Failed to load transactions</strong>
          <span>{error}</span>
        </div>
      )}

      <div className="txn-scroll">
        <table className="txn-table">
          <thead>
            <tr>
              {th("Date", "ts", false)}
              {th("Account", "accountId", false)}
              {th("Amount", "amount", true)}
              {th("Currency", "currency", false)}
              {th("Kind", "kind", false)}
              {th("Category", "category", false)}
              {th("Counterparty", "counterparty", false)}
              <th className="txn-th">Note</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, idx) => (
              <tr key={`${e.entryId}-${idx}`} className="txn-row">
                <td className="txn-cell txn-cell-mono">{formatDateTime(e.ts)}</td>
                <td className={`txn-cell${maskClass}`}>{e.accountId}</td>
                <td className={`txn-cell txn-cell-right${maskClass}`}>{formatAmount(e.amount)}</td>
                <td className={`txn-cell${maskClass}`}>{e.currency}</td>
                <td className={`txn-cell${maskClass}`}>{e.kind}</td>
                <td className={`txn-cell${maskClass}`}>{e.category ?? "\u2014"}</td>
                <td className={`txn-cell${maskClass}`}>{e.counterparty ?? "\u2014"}</td>
                <td className={`txn-cell txn-cell-note${maskClass}`}>{e.note ?? ""}</td>
              </tr>
            ))}
            {!loading && entries.length === 0 && (
              <tr>
                <td className="txn-cell" colSpan={8} style={{ textAlign: "center", color: "var(--muted)" }}>
                  No entries match the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div ref={sentinelRef} className="txn-scroll-sentinel">
        {loading && <span className="loading-indicator">Loading<span className="loading-dots" /></span>}
        {loadingMore && <span className="loading-indicator">Loading more<span className="loading-dots" /></span>}
      </div>
    </>
  );
};
