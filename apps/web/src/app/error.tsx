"use client";

import type { ReactElement } from "react";

import alertStyles from "@/ui/Alert.module.css";
import controlsStyles from "@/ui/Controls.module.css";

type Props = Readonly<{
  error: Error;
  reset: () => void;
}>;

export default function GlobalError(props: Props): ReactElement {
  const { error, reset } = props;

  return (
    <main className="container">
      <section className="panel">
        <div className={alertStyles.alert}>
          <strong>Failed to load page</strong>
          <span>{error.message}</span>
        </div>
        <button className={controlsStyles.segment} type="button" onClick={reset}>
          Retry
        </button>
      </section>
    </main>
  );
}
