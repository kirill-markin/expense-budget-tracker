"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  getChatDraftStorageKey,
  readChatDraft,
  writeChatDraft,
  type ChatDraftScope,
} from "./chatDraftStorage";

type ChatLayoutContextValue = Readonly<{
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  chatWidth: number;
  setChatWidth: (width: number) => void;
  chatDraftText: string;
  setChatDraftText: Dispatch<SetStateAction<string>>;
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
  draftScope: ChatDraftScope;
}>;

type ChatDraftState = Readonly<{
  storageKey: string;
  text: string;
}>;

export const ChatLayoutProvider = (props: Props): ReactElement => {
  const {
    children,
    initialChatOpen,
    initialChatWidth,
    draftScope,
  } = props;
  const [isOpen, setIsOpenState] = useState<boolean>(initialChatOpen);
  const [chatWidth, setChatWidthState] = useState<number>(initialChatWidth);
  const draftStorageKey = getChatDraftStorageKey(draftScope);
  const initialChatDraftState: ChatDraftState = {
    storageKey: draftStorageKey,
    text: "",
  };
  const [chatDraftState, setChatDraftState] = useState<ChatDraftState>(initialChatDraftState);
  const chatDraftStateRef = useRef<ChatDraftState>(initialChatDraftState);

  useEffect(() => {
    const nextState: ChatDraftState = {
      storageKey: draftStorageKey,
      text: readChatDraft(window.sessionStorage, draftScope),
    };
    chatDraftStateRef.current = nextState;
    setChatDraftState(nextState);
  }, [draftScope, draftStorageKey]);

  const setIsOpen = (open: boolean): void => {
    setIsOpenState(open);
    writeCookie("chat-open", String(open));
  };

  const setChatWidth = (width: number): void => {
    setChatWidthState(width);
    writeCookie("chat-width", String(Math.round(width)));
  };

  const setChatDraftText = useCallback((update: SetStateAction<string>): void => {
    const currentText = chatDraftStateRef.current.storageKey === draftStorageKey
      ? chatDraftStateRef.current.text
      : readChatDraft(window.sessionStorage, draftScope);
    const nextText = typeof update === "function" ? update(currentText) : update;
    const nextState: ChatDraftState = {
      storageKey: draftStorageKey,
      text: nextText,
    };

    writeChatDraft(window.sessionStorage, draftScope, nextText);
    chatDraftStateRef.current = nextState;
    setChatDraftState(nextState);
  }, [draftScope, draftStorageKey]);

  const chatDraftText = chatDraftState.storageKey === draftStorageKey
    ? chatDraftState.text
    : "";

  return (
    <ChatLayoutContext.Provider value={{
      isOpen,
      setIsOpen,
      chatWidth,
      setChatWidth,
      chatDraftText,
      setChatDraftText,
    }}>
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
