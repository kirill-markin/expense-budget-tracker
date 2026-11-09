import type { ReactElement } from "react";
import Link from "next/link";

import styles from "./CurrencySelector.module.css";

type Props = Readonly<{
  initialCurrency: string;
  titleText: string;
}>;

/** Currency settings shortcut in the topbar. */
export const CurrencySelector = (props: Props): ReactElement => {
  const { initialCurrency, titleText } = props;

  return (
    <Link href="/settings" className={styles.label} title={titleText} aria-label={`${titleText}: ${initialCurrency}`}>
      {initialCurrency}
    </Link>
  );
};
