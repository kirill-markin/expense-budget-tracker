"use client";

export const logBudgetTableError = (
  operation: string,
  error: unknown,
): void => {
  console.error(`Budget table ${operation} failed:`, error);
};

export const logBudgetTableWarning = (
  operation: string,
  error: unknown,
): void => {
  console.warn(`Budget table ${operation}:`, error);
};
