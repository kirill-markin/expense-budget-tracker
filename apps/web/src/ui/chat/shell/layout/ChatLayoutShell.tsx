"use client";

import { startTransition, useEffect, useLayoutEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { PointerEvent, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";

import {
  getMainContentInvalidationMessageKey,
  getMainContentInvalidationSourceId,
  subscribeToMainContentInvalidation,
} from "../../session/invalidation/mainContentInvalidationChannel";
import { useChatLayout } from "./ChatLayoutProvider";
import { ChatPanel } from "../panel/ChatPanel";
import { ChatToggle } from "./ChatToggle";
import { useChatViewport } from "./chatViewport";
import { clearChatKeyboardViewport, useChatKeyboardViewport } from "./useChatKeyboardViewport";
import styles from "./ChatLayoutShell.module.css";

type Props = Readonly<{
  children: ReactNode;
  workspaceId: string;
}>;

const isBackdropPointer = (event: PointerEvent<HTMLDialogElement>): boolean => {
  if (event.target !== event.currentTarget) return false;

  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right
    || event.clientY < top || event.clientY >= bottom;
};

export const ChatLayoutShell = (props: Props): ReactElement => {
  useChatKeyboardViewport();
  const { children, workspaceId } = props;
  const { isOpen, setIsOpen } = useChatLayout();
  const viewport = useChatViewport();
  const { t } = useTranslation();
  const drawerRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const backdropPointerIdRef = useRef<number | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const isFullscreenChat = pathname === "/chat";
  const isOverlayOpen = !isFullscreenChat && isOpen && viewport === "overlay";
  const canShowSidebar = !isFullscreenChat && viewport !== "phone";
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

  useLayoutEffect(() => {
    const drawer = drawerRef.current;
    if (drawer === null) return;

    if (!isOverlayOpen) {
      drawer.open = isOpen;
      return;
    }

    drawer.open = false;
    drawer.showModal();
    drawer.querySelector<HTMLButtonElement>('[data-testid="chat-sidebar-close"]')?.focus();

    return () => {
      backdropPointerIdRef.current = null;
      clearChatKeyboardViewport();
      drawer.close();
    };
  }, [canShowSidebar, isOpen, isOverlayOpen]);

  return (
    <div className={styles.layoutShell}>
      {canShowSidebar && (
        <dialog
          ref={drawerRef}
          id="chat-sidebar"
          className={styles.sidebarSlot}
          role={isOverlayOpen ? undefined : "presentation"}
          aria-label={isOverlayOpen ? t("chat.title") : undefined}
          onCancel={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            setIsOpen(false);
          }}
          onClose={(event) => {
            if (event.target !== event.currentTarget || isOpen || document.activeElement !== document.body) {
              return;
            }
            const opener = openerRef.current;
            if (opener && opener.getClientRects().length > 0) opener.focus({ preventScroll: true });
          }}
          onPointerDown={(event) => {
            backdropPointerIdRef.current = isOverlayOpen && event.isPrimary && event.button === 0
              && isBackdropPointer(event) ? event.pointerId : null;
          }}
          onPointerUp={(event) => {
            if (event.pointerId !== backdropPointerIdRef.current || !isBackdropPointer(event)) {
              backdropPointerIdRef.current = null;
            }
          }}
          onPointerCancel={() => {
            backdropPointerIdRef.current = null;
          }}
          onClick={(event) => {
            const isBackdropClick = backdropPointerIdRef.current !== null
              && event.target === event.currentTarget && event.detail > 0;
            backdropPointerIdRef.current = null;
            if (isBackdropClick) setIsOpen(false);
          }}
        >
          {isOpen && (
            <ChatPanel key={`sidebar-${workspaceId}`} mode="sidebar" workspaceId={workspaceId} />
          )}
        </dialog>
      )}
      <div
        className={cn(styles.mainContent, !isFullscreenChat && styles.mainContentWithChatClearance)}
      >
        {children}
      </div>
      {canShowSidebar && (!isOpen || viewport === "overlay") && <ChatToggle buttonRef={openerRef} />}
    </div>
  );
};
