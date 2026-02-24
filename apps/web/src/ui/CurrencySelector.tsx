import type { ReactElement } from "react";

type Props = Readonly<{
  initialCurrency: string;
}>;

/** Display-only currency label in the nav bar. Currency is changed via /settings. */
export const CurrencySelector = (props: Props): ReactElement => {
  const { initialCurrency } = props;

  return (
    <span className="currency-label" title="Reporting currency">
      {initialCurrency}
    </span>
  );
};
