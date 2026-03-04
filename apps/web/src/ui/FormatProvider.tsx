"use client";

import { createContext, type ReactElement, type ReactNode, useContext } from "react";

import type { NumberFormat, DateFormat } from "@/lib/locale";

type FormatContextValue = Readonly<{
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
}>;

const FormatContext = createContext<FormatContextValue>({
  numberFormat: "1,234.56",
  dateFormat: "YYYY-MM-DD",
});

type Props = Readonly<{
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  children: ReactNode;
}>;

export const FormatProvider = (props: Props): ReactElement => {
  const { numberFormat, dateFormat, children } = props;
  return (
    <FormatContext value={{ numberFormat, dateFormat }}>
      {children}
    </FormatContext>
  );
};

export const useFormat = (): FormatContextValue => useContext(FormatContext);
