"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { getAttachmentLabel } from "@/lib/chatAttachments";
import { cn } from "@/lib/cn";
import type { StoredMessage } from "@/ui/hooks/useChatHistory";
import {
  AUTO_SCROLL_REANCHOR_DISTANCE_PX,
  getChatScrollDistanceToBottom,
  getNextAutoScrollPinnedState,
} from "../../stream/hooks/chatAutoScroll";
import {
  getDurationParts,
  splitAssistantWorkBlock,
} from "../../stream/display/assistantWorkBlock";
import {
  getOrderedMessageBlocks,
  type OrderedMessageBlock,
} from "../../stream/display/messageContentOrder";
import { getAssistantStreamingIndicator } from "../../stream/display/thinkingSummary";
import {
  getToolCallDisplayState,
  type ToolCallDisplayState,
} from "../../stream/display/toolCallDisplay";
import { ChatMarkdown } from "./ChatMarkdown";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  isAssistantRunActive: boolean;
  isLiveStreamConnected: boolean;
  targetKey: string;
  selectionEpoch: number;
  isDisplayReady: boolean;
}>;

type TranscriptSelection = Readonly<{
  targetKey: string;
  selectionEpoch: number;
}>;

type CachedScrollPosition = Readonly<{
  scrollTop: number;
  savedAt: number;
}>;

const MAX_CACHED_SCROLL_POSITIONS = 5;
const CACHED_SCROLL_POSITION_TTL_MS = 60 * 60 * 1000;

const getUnexpiredScrollPositions = (
  cache: ReadonlyMap<string, CachedScrollPosition>,
  now: number,
): Map<string, CachedScrollPosition> => {
  const unexpiredPositions = new Map<string, CachedScrollPosition>();
  for (const [targetKey, position] of cache) {
    if (now - position.savedAt < CACHED_SCROLL_POSITION_TTL_MS) {
      unexpiredPositions.set(targetKey, position);
    }
  }
  return unexpiredPositions;
};

const cacheScrollPosition = (
  cache: ReadonlyMap<string, CachedScrollPosition>,
  targetKey: string,
  scrollTop: number,
  now: number,
): Map<string, CachedScrollPosition> => {
  const nextCache = getUnexpiredScrollPositions(cache, now);
  nextCache.delete(targetKey);
  nextCache.set(targetKey, { scrollTop, savedAt: now });

  while (nextCache.size > MAX_CACHED_SCROLL_POSITIONS) {
    const oldestTarget = nextCache.keys().next();
    if (oldestTarget.done) {
      return nextCache;
    }
    nextCache.delete(oldestTarget.value);
  }
  return nextCache;
};

const renderToolStatus = (
  displayState: ToolCallDisplayState,
): ReactElement | null => {
  if (displayState.statusKind === "completed") return null;
  return (
    <>
      {" "}
      <span
        className={cn(
          styles.toolCallStatus,
          displayState.statusKind === "failed" ? styles.toolCallStatusFailed : "",
        )}
      >
        {displayState.statusLabel}
      </span>
      {displayState.statusKind === "in_progress" && (
        <span aria-hidden="true" className={styles.dots} />
      )}
    </>
  );
};

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const formatWorkDuration = (durationMs: number, t: Translate): string => {
  const { hours, minutes, seconds } = getDurationParts(durationMs);
  if (hours > 0) return t("chat.durationHours", { hours, minutes });
  if (minutes > 0) return t("chat.durationMinutes", { minutes, seconds });
  return t("chat.durationSeconds", { seconds });
};

const WORKING_DURATION_TICK_MS = 1000;

/** Live "Working for …"; the browser clock may run behind a server-provided start, hence the clamp. */
const WorkingForTitle = (props: Readonly<{ startedAt: number }>): ReactElement => {
  const { startedAt } = props;
  const { t } = useTranslation();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), WORKING_DURATION_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  return <>{t("chat.workingFor", { duration: formatWorkDuration(Math.max(0, now - startedAt), t) })}</>;
};

const renderWorkBlockTitle = (
  message: StoredMessage,
  isRunning: boolean,
  t: Translate,
): ReactElement | string => {
  if (isRunning) return <WorkingForTitle startedAt={message.timestamp} />;
  if (message.completedAt === undefined) return t("chat.worked");
  // A mid-stream snapshot refresh sets a server-clock timestamp, then the live finish stamps a browser-clock completedAt.
  return t("chat.workedFor", {
    duration: formatWorkDuration(Math.max(0, message.completedAt - message.timestamp), t),
  });
};

const renderMessageBlock = (
  message: StoredMessage,
  block: OrderedMessageBlock,
  key: string,
  t: Translate,
): ReactElement => {
  if (block.type === "attachments") {
    return (
      <span key={key}>
        {`[${block.parts.map(getAttachmentLabel).join(", ")}]\n`}
      </span>
    );
  }

  if (block.type === "text") {
    if (message.role === "assistant") {
      return <ChatMarkdown key={key} text={block.text} />;
    }
    return <span key={key}>{block.text}</span>;
  }

  if (block.type === "tool_call") {
    const displayState = getToolCallDisplayState(block.part, (toolKey) => t(toolKey));
    return (
      <details key={key} className={styles.toolCall} data-testid="chat-tool-call">
        <summary className={styles.toolCallSummary}>
          {displayState.label}
          {renderToolStatus(displayState)}
        </summary>
        {displayState.input !== null && (
          <pre className={styles.toolCallInput}>{displayState.input}</pre>
        )}
        {displayState.output !== null && (
          <pre className={styles.toolCallOutput}>{displayState.output}</pre>
        )}
      </details>
    );
  }

  return (
    <details key={key} className={styles.toolCall}>
      <summary className={styles.toolCallSummary}>{t("chat.thinkingSummary")}</summary>
      <pre className={cn(styles.toolCallOutput, styles.reasoningSummaryContent)}>{block.part.summary}</pre>
    </details>
  );
};

/**
 * The work block of an assistant reply: tool calls, reasoning, and intermediate text
 * before the final answer. It stays open while the reply runs and whenever the reply
 * did not finish cleanly with an answer; React only writes `open` when this value
 * changes, so a manual toggle survives unrelated re-renders.
 */
const renderAssistantContent = (
  message: StoredMessage,
  isRunning: boolean,
  isFollowedByAssistantError: boolean,
  t: Translate,
): ReadonlyArray<ReactElement> => {
  const blocks = getOrderedMessageBlocks(message);
  const { attachments, work, answer } = splitAssistantWorkBlock(blocks);
  if (work.length === 0) {
    return blocks.map((block, index) => renderMessageBlock(message, block, `b-${index}`, t));
  }

  const hasAnswer = answer.some((block) => block.text.trim().length > 0);
  const isOpen = isRunning
    || !hasAnswer
    || message.isStopped
    || message.isError
    || isFollowedByAssistantError;

  return [
    ...attachments.map((block, index) => renderMessageBlock(message, block, `a-${index}`, t)),
    <details key="work" className={styles.workBlock} open={isOpen}>
      <summary className={styles.workBlockSummary}>
        {renderWorkBlockTitle(message, isRunning, t)}
      </summary>
      {work.map((block, index) => renderMessageBlock(message, block, `w-${index}`, t))}
    </details>,
    ...answer.map((block, index) => renderMessageBlock(message, block, `t-${index}`, t)),
  ];
};

const renderMessageContent = (
  message: StoredMessage,
  isRunning: boolean,
  isFollowedByAssistantError: boolean,
  t: Translate,
): ReactElement => {
  const elements = message.role === "assistant"
    ? renderAssistantContent(message, isRunning, isFollowedByAssistantError, t)
    : getOrderedMessageBlocks(message).map((block, index) =>
      renderMessageBlock(message, block, `b-${index}`, t));

  return (
    <>
      {elements}
      {message.isStopped && (
        <span className={styles.stoppedNotice}>
          {t("chat.stopped")}
        </span>
      )}
    </>
  );
};

export const ChatTranscript = (props: Props): ReactElement => {
  const {
    messages,
    isAssistantRunActive,
    isLiveStreamConnected,
    targetKey,
    selectionEpoch,
    isDisplayReady,
  } = props;
  const { t } = useTranslation();

  const messagesRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const selectionRef = useRef<TranscriptSelection>({
    targetKey,
    selectionEpoch,
  });
  const scrollPositionsRef = useRef<Map<string, CachedScrollPosition>>(
    new Map<string, CachedScrollPosition>(),
  );
  const hasPositionedHistoryRef = useRef<boolean>(false);
  const positionedMessagesRef = useRef<ReadonlyArray<StoredMessage> | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const autoScrollPinnedRef = useRef<boolean>(true);
  const [isAutoScrollPinned, setIsAutoScrollPinned] = useState<boolean>(true);
  const [isHistoryPositioned, setIsHistoryPositioned] = useState<boolean>(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior): void => {
    const element = messagesRef.current;
    if (element === null) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
  }, []);

  const scheduleScrollToBottom = useCallback((behavior: ScrollBehavior): void => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      scrollToBottom(behavior);
    });
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const previousSelection = selectionRef.current;
    if (previousSelection.selectionEpoch === selectionEpoch) {
      selectionRef.current = { targetKey, selectionEpoch };
      return;
    }

    const element = messagesRef.current;
    if (element !== null && hasPositionedHistoryRef.current) {
      if (autoScrollPinnedRef.current) {
        const nextScrollPositions = new Map(scrollPositionsRef.current);
        nextScrollPositions.delete(previousSelection.targetKey);
        scrollPositionsRef.current = nextScrollPositions;
      } else {
        scrollPositionsRef.current = cacheScrollPosition(
          scrollPositionsRef.current,
          previousSelection.targetKey,
          element.scrollTop,
          Date.now(),
        );
      }
    }
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }

    selectionRef.current = { targetKey, selectionEpoch };
    hasPositionedHistoryRef.current = false;
    positionedMessagesRef.current = null;
    previousScrollTopRef.current = null;
    autoScrollPinnedRef.current = true;
    setIsAutoScrollPinned(true);
    setIsHistoryPositioned(false);
  }, [selectionEpoch, targetKey]);

  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (
      element === null
      || !isDisplayReady
      || hasPositionedHistoryRef.current
    ) {
      return;
    }

    const now = Date.now();
    scrollPositionsRef.current = getUnexpiredScrollPositions(
      scrollPositionsRef.current,
      now,
    );
    const cachedPosition = scrollPositionsRef.current.get(targetKey);
    const nextScrollTop = cachedPosition?.scrollTop ?? element.scrollHeight;
    element.scrollTop = nextScrollTop;
    previousScrollTopRef.current = element.scrollTop;
    hasPositionedHistoryRef.current = true;
    positionedMessagesRef.current = messages;

    const nextPinnedState = cachedPosition === undefined
      || getChatScrollDistanceToBottom(
        element.scrollHeight,
        element.scrollTop,
        element.clientHeight,
      ) <= AUTO_SCROLL_REANCHOR_DISTANCE_PX;
    autoScrollPinnedRef.current = nextPinnedState;
    setIsAutoScrollPinned(nextPinnedState);
    setIsHistoryPositioned(true);
  }, [isDisplayReady, messages, selectionEpoch, targetKey]);

  useEffect(() => {
    const element = messagesRef.current;
    if (element === null) {
      return;
    }

    const onScroll = (): void => {
      const previousScrollTop = previousScrollTopRef.current ?? element.scrollTop;
      const nextPinnedState = getNextAutoScrollPinnedState({
        isPinned: autoScrollPinnedRef.current,
        previousScrollTop,
        currentScrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      });

      previousScrollTopRef.current = element.scrollTop;
      if (nextPinnedState === autoScrollPinnedRef.current) {
        return;
      }

      autoScrollPinnedRef.current = nextPinnedState;
      setIsAutoScrollPinned(nextPinnedState);
    };

    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (
      !isDisplayReady
      || !hasPositionedHistoryRef.current
      || !autoScrollPinnedRef.current
      || positionedMessagesRef.current === messages
    ) {
      return;
    }

    positionedMessagesRef.current = messages;
    const behavior: ScrollBehavior = isAssistantRunActive || isLiveStreamConnected
      ? "instant"
      : "smooth";
    scheduleScrollToBottom(behavior);
  }, [
    isAssistantRunActive,
    isAutoScrollPinned,
    isDisplayReady,
    isLiveStreamConnected,
    messages,
    scheduleScrollToBottom,
  ]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  return (
    <div
      className={styles.messages}
      ref={messagesRef}
      style={isHistoryPositioned ? undefined : { visibility: "hidden" }}
    >
      {messages.length === 0 && (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{t("chat.emptyTitle")}</p>
          <ul className={styles.emptyList}>
            <li>{t("chat.example1")}</li>
            <li>{t("chat.example2")}</li>
            <li>{t("chat.example3")}</li>
          </ul>
          <p className={styles.emptyTitle}>{t("chat.attachTitle")}</p>
          <ul className={styles.emptyList}>
            <li>{t("chat.attachPdf")}</li>
            <li>{t("chat.attachCsv")}</li>
            <li>{t("chat.attachScreenshots")}</li>
          </ul>
        </div>
      )}
      {messages.map((message, index) => {
        const isLastAssistant = isAssistantRunActive
          && message.role === "assistant"
          && index === messages.length - 1;
        const streamingIndicator = getAssistantStreamingIndicator(
          message,
          isAssistantRunActive,
          isLastAssistant,
        );
        const nextMessage: StoredMessage | undefined = messages[index + 1];
        const isFollowedByAssistantError = nextMessage !== undefined
          && nextMessage.role === "assistant"
          && nextMessage.isError;

        return (
          <div
            key={`${message.timestamp}-${index}`}
            className={cn(
              styles.message,
              message.role === "user" ? styles.messageUser : styles.messageAssistant,
              message.isError ? styles.messageError : "",
            )}
          >
            {renderMessageContent(
              message,
              isLastAssistant,
              isFollowedByAssistantError,
              t,
            )}
            {streamingIndicator === "thinking" && (
              <span className={styles.thinkingIndicator}>
                <span>{t("chat.thinking")}</span>
                <span aria-hidden="true" className={styles.dots} />
              </span>
            )}
            {streamingIndicator === "streaming" && (
              <span className={styles.streamingIndicator}>
                <span aria-hidden="true" className={styles.dots} />
              </span>
            )}
          </div>
        );
      })}
      <div
        aria-hidden="true"
        className={cn(
          styles.bottomAnchor,
          isAssistantRunActive && isAutoScrollPinned ? styles.bottomAnchorActive : "",
        )}
      />
    </div>
  );
};
