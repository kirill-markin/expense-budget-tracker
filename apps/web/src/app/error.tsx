"use client";

import type { ReactElement } from "react";

type Props = Readonly<{
  error: Error;
  reset: () => void;
}>;

export default function GlobalError(props: Props): ReactElement {
  const { error, reset } = props;

  return (
    <main className="container">
      <section className="panel">
        <div className="budget-alert">
          <strong>Failed to load page</strong>
          <span>{error.message}</span>
        </div>
        <button className="data-mask-btn" type="button" onClick={reset}>
          Retry
        </button>
      </section>
    </main>
  );
}
