import { type ReactElement } from "react";

import transactionStyles from "./TransactionsTable.module.css";
import type { TransactionCopyFeedback as Feedback } from "./useTransactionClipboard";

type Props = Readonly<{
  feedback: Feedback | null;
}>;

export const TransactionCopyFeedback = (props: Props): ReactElement => {
  const { feedback } = props;

  return (
    <div
      className={[
        transactionStyles.copyFeedback,
        feedback?.kind === "error" ? transactionStyles.copyFeedbackError : "",
      ].join(" ")}
      role="status"
      aria-live="polite"
      data-testid="transaction-copy-feedback"
    >
      {feedback?.message ?? ""}
    </div>
  );
};
