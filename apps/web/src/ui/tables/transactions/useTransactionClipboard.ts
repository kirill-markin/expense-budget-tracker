import { useCallback, useState } from "react";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { serializeTransactionClipboard } from "./transactionClipboard";

export type TransactionCopyFeedback = Readonly<{
  kind: "success" | "error";
  message: string;
}>;

type UseTransactionClipboardResult = Readonly<{
  feedback: TransactionCopyFeedback | null;
  copyTransaction: (entry: LedgerEntry) => Promise<void>;
}>;

export const useTransactionClipboard = (
  successMessage: string,
  failureMessage: string,
): UseTransactionClipboardResult => {
  const [feedback, setFeedback] = useState<TransactionCopyFeedback | null>(null);

  const copyTransaction = useCallback(async (entry: LedgerEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(serializeTransactionClipboard(entry));
      setFeedback({ kind: "success", message: successMessage });
    } catch {
      setFeedback({ kind: "error", message: failureMessage });
    }
  }, [failureMessage, successMessage]);

  return { feedback, copyTransaction };
};
