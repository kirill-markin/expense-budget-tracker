"use client";

import { startTransition, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
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

export const ChatLayoutShell = (props: Props): ReactElement => {
  useChatKeyboardViewport();
  const { children, workspaceId } = props;
  const { isOpen, isOpenDefault, setIsOpen } = useChatLayout();
  const viewport = useChatViewport();
  const { t } = useTranslation();
  const drawerRef = useRef<HTMLDivElement>(null);
  const restoreFocusFrameRef = useRef<number | null>(null);
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

  useEffect(() => {
    if (!isOverlayOpen) return;
    if (restoreFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFocusFrameRef.current);
      restoreFocusFrameRef.current = null;
    }
    const drawer = drawerRef.current;
    const previousFocus = document.activeElement;
    const headerControls = Array.from(document.querySelectorAll<HTMLElement>(
      '.header-sticky .nav, .header-sticky .topbar-brand, .topbar-actions > *',
    ));
    const headerInertStates = headerControls.map((element) => element.inert);
    headerControls.forEach((element) => { element.inert = true; });
    drawer?.querySelector<HTMLButtonElement>('[data-testid="chat-sidebar-close"]')?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const history = document.querySelector<HTMLDialogElement>('[data-testid="chat-history-dialog"][open]');
      if (event.key === "Escape") {
        // History owns dismissal, but its portaled controls stay in the drawer's Tab cycle.
        if (history !== null) return;
        event.preventDefault();
        setIsOpen(false);
      }
      if (event.key !== "Tab" || drawer === null) return;
      const controls = [drawer, ...(history === null ? [] : [history])].flatMap((root) =>
        Array.from(root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
        )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0),
      );
      // Portals can have unrelated page controls between them in document order.
      const currentIndex = controls.findIndex((element) => element === document.activeElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? controls.length : currentIndex) - 1
        : (currentIndex + 1) % controls.length;
      event.preventDefault();
      controls[nextIndex]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      headerControls.forEach((element, index) => { element.inert = headerInertStates[index]; });
      clearChatKeyboardViewport();
      // The keyboard state hides the header; restore focus only after it is visible again.
      restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
        restoreFocusFrameRef.current = null;
        // The floating opener unmounts while the drawer is open, which leaves focus on body.
        const target = previousFocus instanceof HTMLElement && previousFocus !== document.body && previousFocus.isConnected
          ? previousFocus
          : document.querySelector<HTMLButtonElement>('[data-testid="chat-sidebar-open"]');
        if (target?.isConnected && target.getClientRects().length > 0) target.focus();
      });
    };
  }, [isOverlayOpen, setIsOpen]);

  return (
    <div className={styles.layoutShell}>
      {canShowSidebar && isOpen && (
        <>
          <button
            type="button"
            className={cn(styles.backdrop, isOpenDefault && styles.defaultSidebar)}
            data-testid="chat-sidebar-backdrop"
            aria-label={t("chat.close")}
            tabIndex={-1}
            onClick={() => setIsOpen(false)}
          />
          <div
            ref={drawerRef}
            id="chat-sidebar"
            className={cn(styles.sidebarSlot, isOpenDefault && styles.defaultSidebar)}
            role={isOverlayOpen ? "dialog" : undefined}
            aria-modal={isOverlayOpen ? true : undefined}
            aria-label={isOverlayOpen ? t("chat.title") : undefined}
          >
            <ChatPanel key={`sidebar-${workspaceId}`} mode="sidebar" workspaceId={workspaceId} />
          </div>
        </>
      )}
      <div
        className={cn(styles.mainContent, !isFullscreenChat && styles.mainContentWithChatClearance)}
        inert={isOverlayOpen}
      >
        {children}
      </div>
      {canShowSidebar && !isOpen && <ChatToggle />}
    </div>
  );
};
