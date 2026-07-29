"use client";

import {
  type CSSProperties,
  type FocusEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";

import {
  resolveChatHistoryPaginationFocus,
  resolveChatHistoryStatusVisibility,
} from "../../workspace/useChatWorkspaceController";
import { ChatHistoryButton } from "./ChatHistoryButton";
import styles from "./ChatHistoryDialog.module.css";

export type ChatHistorySessionStatus = "idle" | "running" | "interrupted";

export type ChatHistorySession = Readonly<{
  sessionId: string;
  title: string;
  lastMessageAt: string;
  status: ChatHistorySessionStatus;
}>;

type Props = Readonly<{
  open: boolean;
  sessions: ReadonlyArray<ChatHistorySession>;
  selectedSessionId: string | null;
  runningCount: number;
  isLoading: boolean;
  hasLoadedFirstPage: boolean;
  hasMore: boolean;
  errorMessage: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  onCreateDraft: () => void;
  onLoadMore: () => void;
}>;

type SessionListProps = Readonly<{
  headingId: string;
  heading: string;
  sessions: ReadonlyArray<ChatHistorySession>;
  selectedSessionId: string | null;
  activityFormatter: Intl.DateTimeFormat;
  runningStatus: string;
  testId: string;
  onSelectSession: (sessionId: string) => void;
}>;

type VisibleViewport = Readonly<{
  top: number;
  left: number;
  width: number;
  height: number;
}>;

type DialogPosition = Readonly<{
  insetBlockStart: number;
  insetInlineStart: number;
  width: number;
  maxHeight: number;
  viewportInsetBlockStart: number;
  viewportInsetInlineStart: number;
  viewportWidth: number;
  viewportHeight: number;
}>;

type AnchorRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type DialogStyle = CSSProperties & {
  "--chat-history-inset-block-start": string;
  "--chat-history-inset-inline-start": string;
  "--chat-history-width": string;
  "--chat-history-max-height": string;
  "--chat-history-viewport-inset-block-start": string;
  "--chat-history-viewport-inset-inline-start": string;
  "--chat-history-viewport-width": string;
  "--chat-history-viewport-height": string;
};

const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 6;
const MAX_DIALOG_WIDTH_PX = 400;
const MAX_DIALOG_HEIGHT_PX = 560;

const getAnchorRect = (anchor: HTMLButtonElement): AnchorRect => {
  const rect = anchor.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
};

const anchorRectsMatch = (
  first: AnchorRect,
  second: AnchorRect,
): boolean =>
  first.x === second.x
  && first.y === second.y
  && first.width === second.width
  && first.height === second.height;

const dialogPositionsMatch = (
  first: DialogPosition,
  second: DialogPosition,
): boolean =>
  first.insetBlockStart === second.insetBlockStart
  && first.insetInlineStart === second.insetInlineStart
  && first.width === second.width
  && first.maxHeight === second.maxHeight
  && first.viewportInsetBlockStart === second.viewportInsetBlockStart
  && first.viewportInsetInlineStart === second.viewportInsetInlineStart
  && first.viewportWidth === second.viewportWidth
  && first.viewportHeight === second.viewportHeight;

const getVisibleViewport = (): VisibleViewport => {
  const visualViewport = window.visualViewport;
  if (visualViewport === null) {
    return {
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  return {
    top: visualViewport.offsetTop,
    left: visualViewport.offsetLeft,
    width: visualViewport.width,
    height: visualViewport.height,
  };
};

const getDialogPosition = (anchor: HTMLButtonElement): DialogPosition => {
  const anchorRect = anchor.getBoundingClientRect();
  const viewport = getVisibleViewport();
  const viewportInlineEnd = viewport.left + viewport.width;
  const viewportBlockEnd = viewport.top + viewport.height;
  const availableWidth = Math.max(
    0,
    viewport.width - (VIEWPORT_MARGIN_PX * 2),
  );
  const width = Math.min(MAX_DIALOG_WIDTH_PX, availableWidth);
  const minimumLeft = viewport.left + VIEWPORT_MARGIN_PX;
  const maximumLeft = viewportInlineEnd - VIEWPORT_MARGIN_PX - width;
  const isRtl = getComputedStyle(anchor).direction === "rtl";
  const preferredLeft = isRtl
    ? anchorRect.left
    : anchorRect.right - width;
  const left = Math.min(Math.max(preferredLeft, minimumLeft), maximumLeft);
  const minimumTop = viewport.top + VIEWPORT_MARGIN_PX;
  const maximumTop = Math.max(
    minimumTop,
    viewportBlockEnd - VIEWPORT_MARGIN_PX,
  );
  const top = Math.min(
    Math.max(anchorRect.bottom + ANCHOR_GAP_PX, minimumTop),
    maximumTop,
  );
  const maxHeight = Math.min(
    MAX_DIALOG_HEIGHT_PX,
    Math.max(0, viewportBlockEnd - VIEWPORT_MARGIN_PX - top),
  );
  const insetInlineStart = isRtl
    ? window.innerWidth - left - width
    : left;
  const viewportInsetInlineStart = isRtl
    ? window.innerWidth - viewport.left - viewport.width
    : viewport.left;

  return {
    insetBlockStart: top,
    insetInlineStart,
    width,
    maxHeight,
    viewportInsetBlockStart: viewport.top,
    viewportInsetInlineStart,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
};

const formatLastActivity = (
  session: ChatHistorySession,
  formatter: Intl.DateTimeFormat,
  runningStatus: string,
): string => {
  if (session.status === "running") return runningStatus;

  const lastMessageAt = new Date(session.lastMessageAt);
  if (Number.isNaN(lastMessageAt.getTime())) {
    throw new RangeError(
      `Cannot render chat history session ${session.sessionId}: invalid lastMessageAt "${session.lastMessageAt}"`,
    );
  }
  return formatter.format(lastMessageAt);
};

const SessionList = (props: SessionListProps): ReactElement => {
  const {
    headingId,
    heading,
    sessions,
    selectedSessionId,
    activityFormatter,
    runningStatus,
    testId,
    onSelectSession,
  } = props;

  return (
    <section className={styles.section} aria-labelledby={headingId} data-testid={testId}>
      <h3 id={headingId} className={styles.sectionTitle}>{heading}</h3>
      <ul className={styles.sessionList}>
        {sessions.map((session) => {
          const selected = session.sessionId === selectedSessionId;
          const running = session.status === "running";
          const activity = formatLastActivity(session, activityFormatter, runningStatus);

          return (
            <li key={session.sessionId} className={styles.sessionListItem}>
              <button
                type="button"
                className={cn(styles.sessionButton, selected && styles.sessionButtonSelected)}
                data-testid={`chat-history-session-${session.sessionId}`}
                data-chat-history-session-id={session.sessionId}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectSession(session.sessionId)}
              >
                <span className={styles.statusMarkerSlot} aria-hidden="true">
                  {running && <span className={styles.runningMarker} />}
                </span>
                <span className={styles.sessionTitle}>
                  <bdi dir="auto">{session.title}</bdi>
                </span>
                {running ? (
                  <span className={styles.sessionActivity}>{activity}</span>
                ) : (
                  <time className={styles.sessionActivity} dateTime={session.lastMessageAt}>
                    {activity}
                  </time>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export const ChatHistoryDialog = (props: Props): ReactElement => {
  const {
    open,
    sessions,
    selectedSessionId,
    runningCount,
    isLoading,
    hasLoadedFirstPage,
    hasMore,
    errorMessage,
    onOpenChange,
    onSelectSession,
    onCreateDraft,
    onLoadMore,
  } = props;
  const { i18n, t } = useTranslation();
  const reactId = useId();
  const dialogId = `chat-history-dialog-${reactId}`;
  const titleId = `${dialogId}-title`;
  const runningHeadingId = `${dialogId}-running`;
  const recentHeadingId = `${dialogId}-recent`;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const createDraftButtonRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const renderedOpenRef = useRef<boolean>(false);
  const restoreTriggerFocusRef = useRef<boolean>(false);
  const focusedSessionIdRef = useRef<string | null>(null);
  const loadMoreOwnsFocusRef = useRef<boolean>(false);
  const focusedDialogElementRef = useRef<HTMLElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<DialogPosition | null>(null);
  const runningSessions = sessions.filter((session) => session.status === "running");
  const recentSessions = sessions.filter((session) => session.status !== "running");
  const statusVisibility = resolveChatHistoryStatusVisibility(
    sessions.length,
    isLoading,
    hasLoadedFirstPage,
    errorMessage,
  );
  const activityFormatter = useMemo(
    (): Intl.DateTimeFormat => new Intl.DateTimeFormat(
      i18n.resolvedLanguage ?? i18n.language,
      {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      },
    ),
    [i18n.language, i18n.resolvedLanguage],
  );

  const updatePosition = useCallback((): void => {
    const historyButton = historyButtonRef.current;
    if (historyButton === null) {
      throw new Error("Cannot position chat history dialog: history button is not mounted");
    }
    const nextPosition = getDialogPosition(historyButton);
    setPosition((currentPosition) => (
      currentPosition !== null
      && dialogPositionsMatch(currentPosition, nextPosition)
        ? currentPosition
        : nextPosition
    ));
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const handleViewportChange = (): void => updatePosition();
    const historyButton = historyButtonRef.current;
    if (historyButton === null) {
      throw new Error(
        "Cannot observe chat history dialog anchor: history button is not mounted",
      );
    }
    let previousAnchorRect = getAnchorRect(historyButton);
    let animationFrameId = 0;
    const trackAnchorRect = (): void => {
      const currentHistoryButton = historyButtonRef.current;
      if (currentHistoryButton === null) {
        throw new Error(
          "Cannot track chat history dialog anchor: history button is not mounted",
        );
      }
      const currentAnchorRect = getAnchorRect(currentHistoryButton);
      if (!anchorRectsMatch(previousAnchorRect, currentAnchorRect)) {
        previousAnchorRect = currentAnchorRect;
        updatePosition();
      }
      animationFrameId = window.requestAnimationFrame(trackAnchorRect);
    };
    animationFrameId = window.requestAnimationFrame(trackAnchorRect);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        throw new TypeError(
          "Cannot dismiss chat history dialog: pointer target is not a DOM node",
        );
      }
      const dialog = dialogRef.current;
      const historyButton = historyButtonRef.current;
      if (dialog === null || historyButton === null) {
        throw new Error(
          "Cannot dismiss chat history dialog: dialog or history button is not mounted",
        );
      }
      if (dialog.contains(target) || historyButton.contains(target)) return;

      restoreTriggerFocusRef.current = false;
      onOpenChange(false);
    };
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreTriggerFocusRef.current = true;
      onOpenChange(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onOpenChange, open]);

  const dialogOpen = open && position !== null && portalTarget !== null;

  const clearDialogFocusOwner = useCallback((): void => {
    focusedDialogElementRef.current = null;
    focusedSessionIdRef.current = null;
    loadMoreOwnsFocusRef.current = false;
  }, []);

  useLayoutEffect(() => {
    const wasOpen = renderedOpenRef.current;
    if (dialogOpen && !wasOpen) {
      const createDraftButton = createDraftButtonRef.current;
      if (createDraftButton === null) {
        throw new Error("Cannot focus chat history dialog: New chat button is not mounted");
      }
      createDraftButton.focus();
    }
    if (!dialogOpen && wasOpen && restoreTriggerFocusRef.current) {
      const historyButton = historyButtonRef.current;
      if (historyButton === null) {
        throw new Error("Cannot restore chat history focus: history button is not mounted");
      }
      historyButton.focus();
    }
    if (!dialogOpen) {
      restoreTriggerFocusRef.current = false;
    }
    renderedOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  useLayoutEffect(() => {
    if (!open) {
      clearDialogFocusOwner();
      return;
    }
    if (!dialogOpen) return;

    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Cannot restore chat history focus: dialog is not mounted");
    }
    if (document.activeElement !== null && dialog.contains(document.activeElement)) {
      return;
    }
    const focusedDialogElement = focusedDialogElementRef.current;
    if (focusedDialogElement === null) return;
    if (focusedDialogElement.isConnected) {
      clearDialogFocusOwner();
      return;
    }
    const paginationFocusTarget = resolveChatHistoryPaginationFocus(
      loadMoreOwnsFocusRef.current,
      hasMore,
    );
    if (paginationFocusTarget === "create_draft") {
      const createDraftButton = createDraftButtonRef.current;
      if (createDraftButton === null) {
        throw new Error(
          "Cannot restore chat history focus after Load more was removed: New chat button is not mounted",
        );
      }
      loadMoreOwnsFocusRef.current = false;
      createDraftButton.focus();
      return;
    }
    if (paginationFocusTarget === "load_more") {
      const loadMoreButton = loadMoreButtonRef.current;
      if (loadMoreButton === null) {
        throw new Error(
          "Cannot restore chat history focus: Load more button is not mounted",
        );
      }
      loadMoreButton.focus();
      return;
    }

    const focusedSessionId = focusedSessionIdRef.current;
    if (focusedSessionId === null) return;

    const focusedSessionStillExists = sessions.some(
      (session) => session.sessionId === focusedSessionId,
    );
    if (!focusedSessionStillExists) {
      const createDraftButton = createDraftButtonRef.current;
      if (createDraftButton === null) {
        throw new Error(
          `Cannot restore chat history focus after session "${focusedSessionId}" was removed: New chat button is not mounted`,
        );
      }
      createDraftButton.focus();
      focusedSessionIdRef.current = null;
      return;
    }

    const sessionButton = [...dialog.querySelectorAll<HTMLButtonElement>(
      "button[data-chat-history-session-id]",
    )].find(
      (button) => button.dataset.chatHistorySessionId === focusedSessionId,
    );
    if (sessionButton === undefined) {
      throw new Error(
        `Cannot restore chat history row focus: session button "${focusedSessionId}" is not mounted`,
      );
    }
    sessionButton.focus();
  }, [
    clearDialogFocusOwner,
    dialogOpen,
    hasMore,
    isLoading,
    open,
    sessions,
  ]);

  const closeAndRestoreTriggerFocus = (): void => {
    restoreTriggerFocusRef.current = true;
    onOpenChange(false);
  };

  const handleCreateDraft = (): void => {
    restoreTriggerFocusRef.current = false;
    onCreateDraft();
    onOpenChange(false);
  };

  const handleSelectSession = (sessionId: string): void => {
    restoreTriggerFocusRef.current = false;
    onSelectSession(sessionId);
    onOpenChange(false);
  };

  const handleFocusCapture = (event: FocusEvent<HTMLDialogElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      throw new TypeError("Cannot track chat history focus: focused target is not an element");
    }
    focusedDialogElementRef.current = target;
    focusedSessionIdRef.current = target.dataset.chatHistorySessionId ?? null;
    loadMoreOwnsFocusRef.current =
      target.dataset.chatHistoryFocusOwner === "load-more";
  };

  const handleBlurCapture = (event: FocusEvent<HTMLDialogElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      throw new TypeError("Cannot release chat history focus: blurred target is not an element");
    }
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node
      && !event.currentTarget.contains(nextTarget)
      && target.isConnected
    ) {
      clearDialogFocusOwner();
    }
  };

  const dialogStyle: DialogStyle | undefined = position === null
    ? undefined
    : {
        "--chat-history-inset-block-start": `${position.insetBlockStart}px`,
        "--chat-history-inset-inline-start": `${position.insetInlineStart}px`,
        "--chat-history-width": `${position.width}px`,
        "--chat-history-max-height": `${position.maxHeight}px`,
        "--chat-history-viewport-inset-block-start":
          `${position.viewportInsetBlockStart}px`,
        "--chat-history-viewport-inset-inline-start":
          `${position.viewportInsetInlineStart}px`,
        "--chat-history-viewport-width": `${position.viewportWidth}px`,
        "--chat-history-viewport-height": `${position.viewportHeight}px`,
      };

  return (
    <>
      <ChatHistoryButton
        open={open}
        dialogId={dialogId}
        runningCount={runningCount}
        buttonRef={historyButtonRef}
        onOpenChange={onOpenChange}
      />
      {portalTarget !== null && createPortal(
        <dialog
          ref={dialogRef}
          id={dialogId}
          className={styles.dialog}
          data-testid="chat-history-dialog"
          aria-labelledby={titleId}
          aria-busy={isLoading}
          tabIndex={-1}
          open={dialogOpen}
          style={dialogStyle}
          onBlurCapture={handleBlurCapture}
          onFocusCapture={handleFocusCapture}
        >
          <header className={styles.dialogHeader}>
            <h2 id={titleId} className={styles.dialogTitle}>{t("chat.historyTitle")}</h2>
            <div className={styles.dialogActions}>
              <button
                ref={createDraftButtonRef}
                type="button"
                className={styles.dialogAction}
                data-testid="chat-history-new"
                onClick={handleCreateDraft}
              >
                {t("chat.new")}
              </button>
              <button
                type="button"
                className={cn(styles.dialogAction, styles.closeAction)}
                data-testid="chat-history-close"
                aria-label={t("chat.historyClose")}
                title={t("chat.historyClose")}
                onClick={closeAndRestoreTriggerFocus}
              >
                <svg
                  className={styles.closeIcon}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8" />
                  <path d="m12 4-8 8" />
                </svg>
              </button>
            </div>
          </header>
          <div className={styles.dialogBody}>
            {errorMessage !== null && (
              <p
                className={styles.errorState}
                data-testid="chat-history-error"
                role="alert"
              >
                {errorMessage}
              </p>
            )}
            {statusVisibility.showLoading && (
              <p
                className={styles.loadingState}
                data-testid="chat-history-loading"
                role="status"
                aria-live="polite"
              >
                {t("common.loading")}
              </p>
            )}
            {runningSessions.length > 0 && (
              <SessionList
                headingId={runningHeadingId}
                heading={t("chat.historyRunningGroup")}
                sessions={runningSessions}
                selectedSessionId={selectedSessionId}
                activityFormatter={activityFormatter}
                runningStatus={t("chat.historyRunningStatus")}
                testId="chat-history-running"
                onSelectSession={handleSelectSession}
              />
            )}
            {recentSessions.length > 0 && (
              <SessionList
                headingId={recentHeadingId}
                heading={t("chat.historyRecent")}
                sessions={recentSessions}
                selectedSessionId={selectedSessionId}
                activityFormatter={activityFormatter}
                runningStatus={t("chat.historyRunningStatus")}
                testId="chat-history-recent"
                onSelectSession={handleSelectSession}
              />
            )}
            {statusVisibility.showEmpty && (
              <p className={styles.emptyState} data-testid="chat-history-empty">
                {t("chat.historyEmpty")}
              </p>
            )}
            {hasMore && (
              <div className={styles.loadMoreRow}>
                <button
                  ref={loadMoreButtonRef}
                  type="button"
                  className={styles.loadMoreButton}
                  data-testid="chat-history-load-more"
                  data-chat-history-focus-owner="load-more"
                  aria-disabled={isLoading}
                  onClick={() => {
                    if (!isLoading) onLoadMore();
                  }}
                >
                  {isLoading ? t("common.loading") : t("chat.historyLoadMore")}
                </button>
              </div>
            )}
          </div>
        </dialog>,
        portalTarget,
      )}
    </>
  );
};
