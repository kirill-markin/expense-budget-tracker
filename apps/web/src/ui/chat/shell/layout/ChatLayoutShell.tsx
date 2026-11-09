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
import styles from "./ChatLayoutShell.module.css";

type Props = Readonly<{
  children: ReactNode;
  workspaceId: string;
}>;

export const ChatLayoutShell = (props: Props): ReactElement => {
  const { children, workspaceId } = props;
  const { isOpen, isOpenDefault, setIsOpen } = useChatLayout();
  const viewport = useChatViewport();
  const { t } = useTranslation();
  const drawerRef = useRef<HTMLDivElement>(null);
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
    const drawer = drawerRef.current;
    const previousFocus = document.activeElement;
    const headerToggle = document.querySelector<HTMLButtonElement>('[data-testid="chat-header-toggle"]');
    // Keep the drawer's header toggle available as a second dismissal control.
    const headerControls = Array.from(document.querySelectorAll<HTMLElement>(
      '.header-sticky .nav, .header-sticky .topbar-brand, .topbar-actions > :not([data-testid="chat-header-toggle"])',
    ));
    const headerInertStates = headerControls.map((element) => element.inert);
    headerControls.forEach((element) => { element.inert = true; });
    drawer?.querySelector<HTMLButtonElement>('[data-testid="chat-sidebar-close"]')?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      // History is portaled above the drawer and owns its keyboard handling.
      if (document.querySelector('[data-testid="chat-history-dialog"][open]') !== null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
      }
      if (event.key !== "Tab" || drawer === null) return;
      const controls = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
      )).filter((element) => element.getClientRects().length > 0);
      if (headerToggle !== null) controls.unshift(headerToggle);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      headerControls.forEach((element, index) => { element.inert = headerInertStates[index]; });
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      else (headerToggle ?? document.querySelector<HTMLButtonElement>('[data-testid="chat-sidebar-open"]'))?.focus();
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
            aria-owns={isOverlayOpen ? "chat-header-toggle" : undefined}
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
