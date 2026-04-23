"use client";

import { usePathname } from "next/navigation";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

import { useChatLayout } from "./ChatLayoutProvider";
import { ChatPanel } from "./ChatPanel";
import { ChatToggle } from "./ChatToggle";
import styles from "./ChatLayoutShell.module.css";

type Props = Readonly<{
  children: ReactNode;
  workspaceId: string;
}>;

export const ChatLayoutShell = (props: Props): ReactElement => {
  const { children, workspaceId } = props;
  const { isOpen } = useChatLayout();
  const pathname = usePathname();
  const isFullscreenChat = pathname === "/chat";

  return (
    <div className={styles.layoutShell}>
      {!isFullscreenChat && isOpen && <ChatPanel key={`sidebar-${workspaceId}`} mode="sidebar" workspaceId={workspaceId} />}
      <div className={cn(styles.mainContent, !isFullscreenChat && styles.mainContentWithChatClearance)}>
        {children}
      </div>
      {!isFullscreenChat && !isOpen && <ChatToggle />}
    </div>
  );
};
