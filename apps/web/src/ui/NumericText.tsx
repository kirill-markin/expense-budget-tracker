import type { ReactElement, ReactNode } from "react";

type NumericTextProps = Readonly<{
  children: ReactNode;
}>;

// Isolate the display run without changing its parent's alignment or copied text.
export const NumericText = ({ children }: NumericTextProps): ReactElement => (
  <bdi dir="ltr">{children}</bdi>
);
