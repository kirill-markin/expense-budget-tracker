"use client";

import { startTransition, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/cn";

import {
  getMainContentInvalidationMessageKey,
  getMainContentInvalidationSourceId,
  subscribeToMainContentInvalidation,
} from "../../session/invalidation/mainContentInvalidationChannel";
import { useChatLayout } from "./ChatLayoutProvider";
import { ChatPanel } from "../panel/ChatPanel";
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
  const router = useRouter();
  const isFullscreenChat = pathname === "/chat";
  const invalidationSourceIdRef = useRef<string | null>(null);
  const seenInvalidationMessageKeysRef = useRef<Set<string>>(new Set<string>());

  useEffect(() => {
    if (invalidationSourceIdRef.current === null) {
      invalidationSourceIdRef.current = getMainContentInvalidationSourceId();
    }

    const sourceId = invalidationSourceIdRef.current;
    const seenMessageKeys = seenInvalidationMessageKeysRef.current;
    const subscription = subscribeToMainContentInvalidation({
      workspaceId,
      sourceId,
      seenMessageKeys,
      onMessage: (message): void => {
        seenMessageKeys.add(getMainContentInvalidationMessageKey(message));
        startTransition(() => {
          router.refresh();
        });
      },
    });

    return () => subscription.unsubscribe();
  }, [router, workspaceId]);

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
