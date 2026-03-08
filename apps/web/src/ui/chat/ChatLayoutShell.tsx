"use client";

import { usePathname } from "next/navigation";
import type { ReactElement, ReactNode } from "react";

import { useChatLayout } from "./ChatLayoutProvider";
import { ChatPanel } from "./ChatPanel";
import { ChatToggle } from "./ChatToggle";
import styles from "./ChatLayoutShell.module.css";

type Props = Readonly<{
  children: ReactNode;
}>;

export const ChatLayoutShell = (props: Props): ReactElement => {
  const { children } = props;
  const { isOpen } = useChatLayout();
  const pathname = usePathname();
  const isFullscreenChat = pathname === "/chat";

  return (
    <div className={styles.layoutShell}>
      {!isFullscreenChat && isOpen && <ChatPanel mode="sidebar" />}
      <div className={styles.mainContent}>
        {children}
      </div>
      {!isFullscreenChat && !isOpen && <ChatToggle />}
    </div>
  );
};
