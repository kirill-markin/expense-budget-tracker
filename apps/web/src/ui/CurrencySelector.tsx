import type { ReactElement } from "react";

type Props = Readonly<{
  initialCurrency: string;
  titleText: string;
}>;

/** Display-only currency label in the nav bar. Currency is changed via /settings. */
export const CurrencySelector = (props: Props): ReactElement => {
  const { initialCurrency, titleText } = props;

  return (
    <span className="currency-label" title={titleText}>
      {initialCurrency}
    </span>
  );
};
