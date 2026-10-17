"use client";

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

type LowercaseContextValue = Readonly<{
  lowercase: boolean;
  setLowercase: (lowercase: boolean) => void;
  savedLowercase: boolean;
  setSavedLowercase: (lowercase: boolean) => void;
}>;

const LowercaseContext = createContext<LowercaseContextValue | null>(null);

export const LowercaseProvider = (props: Readonly<{
  initialLowercase: boolean;
  children: ReactNode;
}>): ReactElement => {
  const [lowercase, setLowercase] = useState<boolean>(props.initialLowercase);
  const [savedLowercase, setSavedLowercase] = useState<boolean>(props.initialLowercase);

  // Reassert the preview after root refreshes, which also reconcile <html>.
  useLayoutEffect(() => {
    document.documentElement.dataset.lowercase = String(lowercase);
  });

  const value = useMemo<LowercaseContextValue>(
    () => ({ lowercase, setLowercase, savedLowercase, setSavedLowercase }),
    [lowercase, savedLowercase],
  );
  return <LowercaseContext value={value}>{props.children}</LowercaseContext>;
};

export const useLowercase = (): LowercaseContextValue => {
  const context = useContext(LowercaseContext);
  if (context === null) {
    throw new Error("useLowercase must be used within a LowercaseProvider");
  }
  return context;
};
