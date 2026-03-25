"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { useChatLayout } from "./ChatLayoutProvider";
import { ChatComposer } from "./ChatComposer";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { ChatTranscript } from "./ChatTranscript";
import { prepareAttachment, checkFileSize, type PendingAttachment } from "./FileAttachment";
import { buildChatTranscriptMarkdown } from "./chatTranscriptMarkdown";
import { useChatSessionController } from "./useChatSessionController";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  mode: "sidebar" | "fullscreen";
  workspaceId: string;
}>;

type CopyStatus = "idle" | "success" | "error";

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

export const ChatPanel = (props: Props): ReactElement => {
  const { mode, workspaceId } = props;
  const { t } = useTranslation();
  const { setIsOpen, chatWidth, setChatWidth } = useChatLayout();
  const {
    messages,
    runState,
    isHistoryLoaded,
    isAssistantRunActive,
    isLiveStreamConnected,
    isStopping,
    composerAction,
    sendMessage,
    stopMessage,
    clearConversation,
  } = useChatSessionController({ mode, workspaceId });

  const [localWidth, setLocalWidth] = useState<number>(chatWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [inputText, setInputText] = useState<string>("");
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>([]);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");

  const dragCounterRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const copyStatusResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const isRtl = document.documentElement.dir === "rtl";
      const rawWidth = isRtl ? window.innerWidth - e.clientX : e.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(rawWidth, MAX_WIDTH));
      setLocalWidth(newWidth);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
      setChatWidth(localWidth);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging, localWidth, setChatWidth]);

  useEffect(() => {
    return () => {
      if (copyStatusResetRef.current !== null) {
        clearTimeout(copyStatusResetRef.current);
      }
    };
  }, []);

  const handleAttach = useCallback((attachment: PendingAttachment): void => {
    setPendingAttachments((prev) => [...prev, attachment]);
  }, []);

  const removeAttachment = useCallback((index: number): void => {
    setPendingAttachments((prev) => [...prev.slice(0, index), ...prev.slice(index + 1)]);
  }, []);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    let hasAttachedFile = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sizeError = checkFileSize(file);
      if (sizeError !== null) {
        alert(sizeError);
        continue;
      }
      const attachment = await prepareAttachment(file);
      handleAttach(attachment);
      hasAttachedFile = true;
    }

    if (hasAttachedFile) {
      textareaRef.current?.focus();
    }
  }, [handleAttach]);

  const canSendPendingMessage = isHistoryLoaded
    && !isStopping
    && !isAssistantRunActive
    && !isLiveStreamConnected
    && (inputText.trim().length > 0 || pendingAttachments.length > 0);

  const sendPendingMessage = useCallback(async (): Promise<void> => {
    if (!canSendPendingMessage) {
      return;
    }

    const nextText = inputText;
    const nextAttachments = pendingAttachments;
    setInputText("");
    setPendingAttachments([]);

    await sendMessage({
      text: nextText,
      attachments: nextAttachments,
    });
  }, [canSendPendingMessage, inputText, pendingAttachments, sendMessage]);

  const handleCopyTranscript = useCallback(async (): Promise<void> => {
    try {
      const { markdown } = await buildChatTranscriptMarkdown({
        messages,
        runState,
        exportedAt: Date.now(),
        t: (key, params) => t(key, params),
      });
      await navigator.clipboard.writeText(markdown);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }

    if (copyStatusResetRef.current !== null) {
      clearTimeout(copyStatusResetRef.current);
    }
    copyStatusResetRef.current = setTimeout(() => {
      setCopyStatus("idle");
      copyStatusResetRef.current = null;
    }, 1500);
  }, [messages, runState, t]);

  const copyButtonLabel = copyStatus === "success"
    ? t("chat.copied")
    : copyStatus === "error"
      ? t("chat.copyFailed")
      : t("chat.copyTranscript");
  const transcriptActionsDisabled = !isHistoryLoaded || messages.length === 0;

  const rootClass = mode === "sidebar" ? styles.sidebar : styles.sidebarFullscreen;
  const sidebarStyle = mode === "sidebar" ? { width: localWidth } : undefined;

  return (
    <div
      className={rootClass}
      style={sidebarStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {isDragOver && <div className={styles.dropOverlay}>{t("chat.dropFiles")}</div>}
      {mode === "sidebar" && (
        <div
          className={cn(styles.resizeHandle, isDragging ? styles.resizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
      )}
      <ChatPanelHeader
        mode={mode}
        transcriptActionsDisabled={transcriptActionsDisabled}
        copyButtonLabel={copyButtonLabel}
        onCopyTranscript={() => void handleCopyTranscript()}
        onClearConversation={() => void clearConversation()}
        onCloseSidebar={() => setIsOpen(false)}
      />
      <ChatTranscript
        messages={messages}
        isAssistantRunActive={isAssistantRunActive}
        isLiveStreamConnected={isLiveStreamConnected}
      />
      <ChatComposer
        inputText={inputText}
        pendingAttachments={pendingAttachments}
        composerAction={composerAction}
        isHistoryLoaded={isHistoryLoaded}
        isStopping={isStopping}
        isLiveStreamConnected={isLiveStreamConnected}
        textareaRef={textareaRef}
        onInputChange={setInputText}
        onAttach={handleAttach}
        onRemoveAttachment={removeAttachment}
        onSend={sendPendingMessage}
        onStop={stopMessage}
      />
    </div>
  );
};
