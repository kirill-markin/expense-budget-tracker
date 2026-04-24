"use client";

export const logBudgetTableError = (
  operation: string,
  error: unknown,
): void => {
  console.error(`Budget table ${operation} failed:`, error);
};
