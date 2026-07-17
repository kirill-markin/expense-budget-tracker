export type AccountStatus = "active" | "inactive";

const ACCOUNT_INACTIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export const computeAccountStatus = (
  balance: number,
  lastNonTransferTimeMs: number | null,
  currentTimeMs: number,
): AccountStatus => {
  if (balance !== 0) return "active";
  if (lastNonTransferTimeMs === null) return "inactive";

  return currentTimeMs - lastNonTransferTimeMs > ACCOUNT_INACTIVE_AFTER_MS
    ? "inactive"
    : "active";
};
