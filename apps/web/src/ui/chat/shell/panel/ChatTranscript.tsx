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
import { getOrderedMessageBlocks } from "../../stream/display/messageContentOrder";
import { getAssistantStreamingIndicator } from "../../stream/display/thinkingSummary";
import { getToolCallDisplayState } from "../../stream/display/toolCallDisplay";
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

const renderMessageContent = (
  message: StoredMessage,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
): ReactElement => {
  const elements: Array<ReactElement> = getOrderedMessageBlocks(message).map((block, index) => {
    if (block.type === "attachments") {
      return (
        <span key={`a-${index}`}>
          {`[${block.parts.map(getAttachmentLabel).join(", ")}]\n`}
        </span>
      );
    }

    if (block.type === "text") {
      return <span key={`t-${index}`}>{block.text}</span>;
    }

    if (block.type === "tool_call") {
      const displayState = getToolCallDisplayState(block.part, (key) => t(key));
      return (
        <details
          key={`tc-${index}`}
          className={cn(styles.toolCall, block.part.status === "started" ? styles.toolCallStarted : "")}
        >
          <summary className={styles.toolCallSummary}>{`${displayState.label} (${displayState.statusLabel})`}</summary>
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
      <details
        key={`rs-${index}`}
        className={cn(styles.toolCall, styles.reasoningSummary)}
      >
        <summary className={styles.toolCallSummary}>{t("chat.thinkingSummary")}</summary>
        <pre className={cn(styles.toolCallOutput, styles.reasoningSummaryContent)}>{block.part.summary}</pre>
      </details>
    );
  });

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

        return (
          <div
            key={`${message.timestamp}-${index}`}
            className={cn(
              styles.message,
              message.role === "user" ? styles.messageUser : styles.messageAssistant,
              message.isError ? styles.messageError : "",
            )}
          >
            {renderMessageContent(message, t)}
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
