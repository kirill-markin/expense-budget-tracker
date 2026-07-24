"use client";

import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_BUDGET_ADJUSTMENTS_COOKIE } from "@/lib/demoCookies";
import alertStyles from "@/ui/Alert.module.css";
import controlsStyles from "@/ui/Controls.module.css";

type Props = Readonly<{
  error: Error;
  reset: () => void;
}>;

export default function GlobalError(props: Props): ReactElement {
  const { error, reset } = props;
  const { t } = useTranslation();
  const [canResetDemoAdjustments, setCanResetDemoAdjustments] =
    useState<boolean>(false);

  useEffect((): void => {
    const cookiePrefix = `${DEMO_BUDGET_ADJUSTMENTS_COOKIE}=`;
    setCanResetDemoAdjustments(document.cookie.split(";").some((part): boolean =>
      part.trim().startsWith(cookiePrefix)));
  }, []);

  const resetDemoAdjustments = (): void => {
    if (!window.confirm(
      t("pageError.resetDemoChangesConfirm"),
    )) {
      return;
    }
    document.cookie =
      `${DEMO_BUDGET_ADJUSTMENTS_COOKIE}=; path=/; max-age=0; samesite=lax`;
    window.location.reload();
  };

  return (
    <main className="container">
      <section className="panel" data-testid="page-load-error">
        <div className={alertStyles.alert}>
          <strong>Failed to load page</strong>
          <span>{error.message}</span>
        </div>
        <div className={controlsStyles.segmented}>
          <button className={controlsStyles.segment} type="button" onClick={reset}>
            Retry
          </button>
          {canResetDemoAdjustments && (
            <button
              className={controlsStyles.segment}
              type="button"
              data-testid="page-load-error-reset-demo-adjustments"
              onClick={resetDemoAdjustments}
            >
              {t("pageError.resetDemoChanges")}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
