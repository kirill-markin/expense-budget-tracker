import type { StoredMessage } from "@/lib/chatHistory";
import type {
  ReasoningSummaryContentPart,
  ToolCallContentPart,
} from "@/server/chat/types";

export type OrderedMessageBlock =
  | Readonly<{
    type: "attachments";
    names: ReadonlyArray<string>;
  }>
  | Readonly<{
    type: "text";
    text: string;
  }>
  | Readonly<{
    type: "tool_call";
    part: ToolCallContentPart;
  }>
  | Readonly<{
    type: "reasoning_summary";
    part: ReasoningSummaryContentPart;
  }>;

const getAttachmentNames = (
  message: StoredMessage,
): ReadonlyArray<string> =>
  message.content.flatMap((part) => {
    if (part.type === "file") {
      return [part.fileName];
    }
    if (part.type === "image") {
      return ["[image]"];
    }
    return [];
  });

export const getOrderedMessageBlocks = (
  message: StoredMessage,
): ReadonlyArray<OrderedMessageBlock> => {
  const attachmentNames = getAttachmentNames(message);
  const blocks: Array<OrderedMessageBlock> = [];
  let attachmentBlockInserted = false;

  for (const part of message.content) {
    if (part.type === "text") {
      if (!attachmentBlockInserted && attachmentNames.length > 0) {
        blocks.push({
          type: "attachments",
          names: attachmentNames,
        });
        attachmentBlockInserted = true;
      }
      blocks.push({
        type: "text",
        text: part.text,
      });
      continue;
    }

    if (part.type === "tool_call") {
      blocks.push({
        type: "tool_call",
        part,
      });
      continue;
    }

    if (part.type === "reasoning_summary") {
      blocks.push({
        type: "reasoning_summary",
        part,
      });
    }
  }

  if (!attachmentBlockInserted && attachmentNames.length > 0) {
    return [
      {
        type: "attachments",
        names: attachmentNames,
      },
      ...blocks,
    ];
  }

  return blocks;
};
