import type { StoredMessage } from "@/lib/chatHistory";
import { serializeAttachmentForMarkdown } from "@/lib/chatAttachments";
import { getOrderedMessageBlocks } from "./messageContentOrder";
import { getAssistantStreamingIndicator } from "./thinkingSummary";
import { getToolCallDisplayState } from "./toolCallDisplay";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export type ChatTranscriptMarkdown = Readonly<{
  markdown: string;
  suggestedFileName: string;
}>;

type BuildChatTranscriptMarkdownParams = Readonly<{
  messages: ReadonlyArray<StoredMessage>;
  runState: "idle" | "running" | "interrupted";
  exportedAt: number;
  t: Translate;
}>;

const padUtcNumber = (
  value: number,
): string =>
  value.toString().padStart(2, "0");

export const formatUtcTimestamp = (
  timestamp: number,
): string => {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = padUtcNumber(date.getUTCMonth() + 1);
  const day = padUtcNumber(date.getUTCDate());
  const hours = padUtcNumber(date.getUTCHours());
  const minutes = padUtcNumber(date.getUTCMinutes());
  const seconds = padUtcNumber(date.getUTCSeconds());
  return `${String(year)}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

export const buildChatTranscriptSuggestedFileName = (
  exportedAt: number,
): string =>
  `ai-chat-${formatUtcTimestamp(exportedAt).replaceAll(":", "-").replace(" ", "_")}.md`;

const getMessageAuthorLabel = (
  role: StoredMessage["role"],
  t: Translate,
): string =>
  role === "user" ? t("chat.exportAuthorUser") : t("chat.exportAuthorAssistant");

const pushCodeBlock = (
  lines: Array<string>,
  content: string,
): void => {
  lines.push("```text");
  lines.push(content);
  lines.push("```");
};

const pushStatuses = (
  lines: Array<string>,
  message: StoredMessage,
  t: Translate,
): void => {
  const statuses: Array<string> = [];
  if (message.isError) {
    statuses.push(t("chat.exportError"));
  }
  if (message.isStopped) {
    statuses.push(t("chat.stopped"));
  }
  if (statuses.length > 0) {
    lines.push(`${t("chat.exportStatus")}: ${statuses.join(", ")}`);
    lines.push("");
  }
};

const pushActivity = (
  lines: Array<string>,
  message: StoredMessage,
  runState: BuildChatTranscriptMarkdownParams["runState"],
  isLastMessage: boolean,
  t: Translate,
): void => {
  const indicator = getAssistantStreamingIndicator(message, runState === "running", isLastMessage);
  if (indicator === "hidden") {
    return;
  }
  const label = indicator === "thinking"
    ? t("chat.thinking")
    : t("chat.toolStatusInProgress");
  lines.push(`${t("chat.exportActivity")}: ${label}`);
  lines.push("");
};

export const buildChatTranscriptMarkdown = async (
  params: BuildChatTranscriptMarkdownParams,
): Promise<ChatTranscriptMarkdown> => {
  const { messages, runState, exportedAt, t } = params;
  const suggestedFileName = buildChatTranscriptSuggestedFileName(exportedAt);
  const lines: Array<string> = [
    `# ${t("chat.exportTitle")}`,
    "",
    t("chat.exportTimestampsUtc"),
    "",
    `${t("chat.exportedAt")}: ${formatUtcTimestamp(exportedAt)}`,
    `${t("chat.exportSuggestedFilename")}: ${suggestedFileName}`,
  ];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const isLastMessage = messageIndex === messages.length - 1 && message.role === "assistant";
    lines.push("");
    lines.push(`## ${t("chat.exportMessageHeading", {
      index: messageIndex + 1,
      author: getMessageAuthorLabel(message.role, t),
    })}`);
    lines.push(`${t("chat.exportTime")}: ${formatUtcTimestamp(message.timestamp)}`);
    lines.push("");

    pushStatuses(lines, message, t);
    if (message.role === "assistant") {
      pushActivity(lines, message, runState, isLastMessage, t);
    }

    for (const block of getOrderedMessageBlocks(message)) {
      if (block.type === "attachments") {
        lines.push(`### ${t("chat.exportAttachments")}`);
        for (const part of block.parts) {
          const attachment = await serializeAttachmentForMarkdown(part);
          lines.push(`#### ${attachment.label} (${attachment.mediaType})`);
          lines.push(...attachment.lines);
          lines.push("");
        }
      } else if (block.type === "text") {
        lines.push(block.text);
        lines.push("");
      } else if (block.type === "tool_call") {
        const displayState = getToolCallDisplayState(block.part, (key) => t(key));
        lines.push(`### ${displayState.label} (${displayState.statusLabel})`);
        if (displayState.input !== null) {
          lines.push(`#### ${t("chat.exportRequest")}`);
          pushCodeBlock(lines, displayState.input);
        }
        if (displayState.output !== null) {
          lines.push(`#### ${t("chat.exportResponse")}`);
          pushCodeBlock(lines, displayState.output);
        }
        lines.push("");
      } else if (block.type === "reasoning_summary") {
        lines.push(`### ${t("chat.thinkingSummary")}`);
        pushCodeBlock(lines, block.part.summary);
        lines.push("");
      }
    }

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  return {
    markdown: lines.join("\n"),
    suggestedFileName,
  };
};
