"use client";

import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
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
  const previousOpenRef = useRef<boolean>(false);
  const focusedSessionIdRef = useRef<string | null>(null);
  const loadMoreOwnsFocusRef = useRef<boolean>(false);
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

  useLayoutEffect(() => {
    if (!open) {
      focusedSessionIdRef.current = null;
      loadMoreOwnsFocusRef.current = false;
      return;
    }

    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Cannot restore chat history focus: dialog is not mounted");
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
    if (document.activeElement !== null && dialog.contains(document.activeElement)) {
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
  }, [hasMore, isLoading, open, sessions]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Cannot synchronize chat history dialog: dialog is not mounted");
    }

    if (open) {
      if (!dialog.open) dialog.showModal();
      const createDraftButton = createDraftButtonRef.current;
      if (createDraftButton === null) {
        throw new Error("Cannot focus chat history dialog: New chat button is not mounted");
      }
      createDraftButton.focus();
    } else {
      if (dialog.open) dialog.close();
      if (previousOpenRef.current) {
        const historyButton = historyButtonRef.current;
        if (historyButton === null) {
          throw new Error("Cannot restore chat history focus: history button is not mounted");
        }
        historyButton.focus();
      }
    }

    previousOpenRef.current = open;
  }, [open]);

  const closeDialog = (): void => {
    onOpenChange(false);
  };

  const handleCreateDraft = (): void => {
    onCreateDraft();
    closeDialog();
  };

  const handleSelectSession = (sessionId: string): void => {
    onSelectSession(sessionId);
    closeDialog();
  };

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.preventDefault();
    closeDialog();
  };

  const handleFocusCapture = (event: FocusEvent<HTMLDialogElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      throw new TypeError("Cannot track chat history focus: focused target is not an element");
    }
    focusedSessionIdRef.current = target.dataset.chatHistorySessionId ?? null;
    loadMoreOwnsFocusRef.current =
      target.dataset.chatHistoryFocusOwner === "load-more";
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Cannot contain chat history focus: dialog is not mounted");
    }
    const focusableElements = [...dialog.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    )];
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;
    const focusIsOutside = activeElement === null || !dialog.contains(activeElement);
    if (event.shiftKey && (activeElement === firstElement || focusIsOutside)) {
      event.preventDefault();
      lastElement.focus();
      return;
    }
    if (!event.shiftKey && (activeElement === lastElement || focusIsOutside)) {
      event.preventDefault();
      firstElement.focus();
    }
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
      <dialog
        ref={dialogRef}
        id={dialogId}
        className={styles.dialog}
        data-testid="chat-history-dialog"
        aria-labelledby={titleId}
        aria-busy={isLoading}
        tabIndex={-1}
        onCancel={handleCancel}
        onFocusCapture={handleFocusCapture}
        onKeyDown={handleKeyDown}
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
              onClick={closeDialog}
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
      </dialog>
    </>
  );
};
