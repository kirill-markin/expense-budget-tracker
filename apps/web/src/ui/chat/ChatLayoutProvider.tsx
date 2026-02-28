"use client";

import { createContext, useContext, useState, type ReactElement, type ReactNode } from "react";

type ChatLayoutContextValue = Readonly<{
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  chatWidth: number;
  setChatWidth: (width: number) => void;
}>;

const ChatLayoutContext = createContext<ChatLayoutContextValue | null>(null);

const COOKIE_MAX_AGE = "max-age=31536000";

const writeCookie = (name: string, value: string): void => {
  document.cookie = `${name}=${value}; path=/; ${COOKIE_MAX_AGE}`;
};

type Props = Readonly<{
  children: ReactNode;
  initialChatOpen: boolean;
  initialChatWidth: number;
}>;

export const ChatLayoutProvider = (props: Props): ReactElement => {
  const { children, initialChatOpen, initialChatWidth } = props;
  const [isOpen, setIsOpenState] = useState<boolean>(initialChatOpen);
  const [chatWidth, setChatWidthState] = useState<number>(initialChatWidth);

  const setIsOpen = (open: boolean): void => {
    setIsOpenState(open);
    writeCookie("chat-open", String(open));
  };

  const setChatWidth = (width: number): void => {
    setChatWidthState(width);
    writeCookie("chat-width", String(Math.round(width)));
  };

  return (
    <ChatLayoutContext.Provider value={{ isOpen, setIsOpen, chatWidth, setChatWidth }}>
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
