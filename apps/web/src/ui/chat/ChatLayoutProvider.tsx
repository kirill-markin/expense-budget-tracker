"use client";

import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

type ChatLayoutContextValue = Readonly<{
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}>;

const STORAGE_KEY = "expense-tracker-chat-open";

const ChatLayoutContext = createContext<ChatLayoutContextValue | null>(null);

type Props = Readonly<{
  children: ReactNode;
}>;

export const ChatLayoutProvider = (props: Props): ReactElement => {
  const { children } = props;
  const [isOpen, setIsOpenState] = useState<boolean>(false);

  // Restore from localStorage after hydration
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "true") {
      setIsOpenState(true);
    }
  }, []);

  const setIsOpen = (open: boolean): void => {
    setIsOpenState(open);
    localStorage.setItem(STORAGE_KEY, String(open));
  };

  return (
    <ChatLayoutContext.Provider value={{ isOpen, setIsOpen }}>
      {children}
    </ChatLayoutContext.Provider>
  );
};

export const useChatLayout = (): ChatLayoutContextValue => {
  const ctx = useContext(ChatLayoutContext);
  if (ctx === null) {
    throw new Error("useChatLayout must be used within a ChatLayoutProvider");
  }
  return ctx;
};
