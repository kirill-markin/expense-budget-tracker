import { useCallback, useEffect, useRef, useState } from "react";

import type { InfiniteScrollState, PageResult } from "./types";

export const useInfiniteScroll = <T>(
  fetchPage: (limit: number, offset: number) => Promise<PageResult<T>>,
  pageSize: number,
  deps: ReadonlyArray<unknown>,
): InfiniteScrollState<T> => {
  const [rows, setRows] = useState<ReadonlyArray<T>>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fetchIdRef = useRef<number>(0);

  const stableFetchPage = useCallback(fetchPage, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    setRows([]);
    setTotal(0);

    stableFetchPage(pageSize, 0)
      .then((result) => {
        if (fetchIdRef.current !== fetchId) return;
        setRows(result.items);
        setTotal(result.total);
      })
      .catch((err: unknown) => {
        if (fetchIdRef.current !== fetchId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (fetchIdRef.current !== fetchId) return;
        setLoading(false);
      });
  }, [stableFetchPage, pageSize]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (intersections) => {
        if (!intersections[0].isIntersecting) return;
        if (loadingMore || loading) return;
        if (rows.length >= total) return;

        const fetchId = fetchIdRef.current;
        setLoadingMore(true);
        stableFetchPage(pageSize, rows.length)
          .then((result) => {
            if (fetchIdRef.current !== fetchId) return;
            setRows((prev) => [...prev, ...result.items]);
            setTotal(result.total);
          })
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
  }, [rows.length, total, loading, loadingMore, stableFetchPage, pageSize]);

  return { rows, total, loading, loadingMore, error, sentinelRef, setRows, setTotal, setError };
};
