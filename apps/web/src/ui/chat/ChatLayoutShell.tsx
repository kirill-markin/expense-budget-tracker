"use client";

import type { ReactElement, ReactNode } from "react";
import { useChatLayout } from "./ChatLayoutProvider";
import { ChatPanel } from "./ChatPanel";
import { ChatToggle } from "./ChatToggle";

type Props = Readonly<{
  children: ReactNode;
}>;

export const ChatLayoutShell = (props: Props): ReactElement => {
  const { children } = props;
  const { isOpen } = useChatLayout();

  return (
    <div className="chat-layout-shell">
      {isOpen && <ChatPanel mode="sidebar" />}
      <div className="chat-main-content">
        {children}
      </div>
      {!isOpen && <ChatToggle />}
    </div>
  );
};
