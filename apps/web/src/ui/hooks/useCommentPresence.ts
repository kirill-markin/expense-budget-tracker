"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CommentedCell } from "@/server/budget/getCommentedCells";

type CommentPresenceResult = Readonly<{
  cells: ReadonlyArray<CommentedCell>;
}>;

const cellKey = (month: string, direction: string, category: string): string =>
  `${month}::${direction}::${category}`;

const fetchCommentPresence = async (monthFrom: string, monthTo: string): Promise<ReadonlyArray<CommentedCell>> => {
  const params = new URLSearchParams({ monthFrom, monthTo });
  const response = await fetch(`/api/budget-comments-exist?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Comment presence fetch failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as CommentPresenceResult;
  return data.cells;
};

export type CommentPresenceState = Readonly<{
  commentedCells: ReadonlySet<string>;
  fetchRange: (monthFrom: string, monthTo: string) => void;
  updateCell: (month: string, direction: string, category: string, hasComment: boolean) => void;
}>;

/**
 * Background-loads comment presence for budget cells within a month range.
 * Fires on mount for the initial range and exposes fetchRange for scroll-loaded ranges.
 */
export const useCommentPresence = (initialMonthFrom: string, initialMonthTo: string): CommentPresenceState => {
  const [commentedCells, setCommentedCells] = useState<ReadonlySet<string>>(new Set());
  const initialFetchedRef = useRef<boolean>(false);

  useEffect(() => {
    if (initialFetchedRef.current) return;
    initialFetchedRef.current = true;

    fetchCommentPresence(initialMonthFrom, initialMonthTo)
      .then((cells) => {
        const keys = new Set(cells.map((c) => cellKey(c.month, c.direction, c.category)));
        setCommentedCells(keys);
      })
      .catch((error) => console.error("Failed to load comment presence:", error));
  }, [initialMonthFrom, initialMonthTo]);

  const fetchRange = useCallback((monthFrom: string, monthTo: string): void => {
    fetchCommentPresence(monthFrom, monthTo)
      .then((cells) => {
        if (cells.length === 0) return;
        const newKeys = cells.map((c) => cellKey(c.month, c.direction, c.category));
        setCommentedCells((prev) => {
          const merged = new Set(prev);
          for (const key of newKeys) {
            merged.add(key);
          }
          return merged;
        });
      })
      .catch((error) => console.error("Failed to load comment presence for range:", error));
  }, []);

  const updateCell = useCallback((month: string, direction: string, category: string, hasComment: boolean): void => {
    const key = cellKey(month, direction, category);
    setCommentedCells((prev) => {
      if (hasComment && prev.has(key)) return prev;
      if (!hasComment && !prev.has(key)) return prev;
      const next = new Set(prev);
      if (hasComment) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  return { commentedCells, fetchRange, updateCell };
};
