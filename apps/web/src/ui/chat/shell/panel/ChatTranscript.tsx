"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { getAttachmentLabel } from "@/lib/chatAttachments";
import { cn } from "@/lib/cn";
import type { StoredMessage } from "@/ui/hooks/useChatHistory";
import { getNextAutoScrollPinnedState } from "../../stream/hooks/chatAutoScroll";
import { getOrderedMessageBlocks } from "../../stream/display/messageContentOrder";
import { getAssistantStreamingIndicator } from "../../stream/display/thinkingSummary";
import { getToolCallDisplayState } from "../../stream/display/toolCallDisplay";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  isAssistantRunActive: boolean;
  isLiveStreamConnected: boolean;
}>;

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
  } = props;
  const { t } = useTranslation();

  const messagesRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const initialScrollDoneRef = useRef<boolean>(false);
  const previousScrollTopRef = useRef<number | null>(null);
  const autoScrollPinnedRef = useRef<boolean>(true);
  const [isAutoScrollPinned, setIsAutoScrollPinned] = useState<boolean>(true);

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
    if (!isAutoScrollPinned) {
      return;
    }

    const behavior: ScrollBehavior = isAssistantRunActive || isLiveStreamConnected || !initialScrollDoneRef.current
      ? "instant"
      : "smooth";
    scheduleScrollToBottom(behavior);

    if (!initialScrollDoneRef.current && messages.length > 0) {
      initialScrollDoneRef.current = true;
    }
  }, [
    isAssistantRunActive,
    isAutoScrollPinned,
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
    <div className={styles.messages} ref={messagesRef}>
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
