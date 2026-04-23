import {
  compareStreamPosition,
  isOrderedAssistantPart,
  type OrderedAssistantContentPart,
  type StoredMessage,
} from "@/lib/chatHistory";
import { type AttachmentContentPart } from "@/lib/chatAttachments";
import type {
  ReasoningSummaryContentPart,
  ToolCallContentPart,
} from "@/server/chat/types";

export type OrderedMessageBlock =
  | Readonly<{
    type: "attachments";
    parts: ReadonlyArray<AttachmentContentPart>;
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

const getAttachmentParts = (
  message: StoredMessage,
): ReadonlyArray<AttachmentContentPart> =>
  message.content.filter((part): part is AttachmentContentPart =>
    part.type === "file" || part.type === "image");

const isRenderableNonAttachmentPart = (
  part: StoredMessage["content"][number],
): boolean =>
  part.type === "text" || part.type === "tool_call" || part.type === "reasoning_summary";

const getRenderableParts = (
  message: StoredMessage,
): ReadonlyArray<StoredMessage["content"][number]> => {
  const renderableParts = message.content.filter(isRenderableNonAttachmentPart);
  if (message.role !== "assistant") {
    return renderableParts;
  }

  if (!renderableParts.every(isOrderedAssistantPart)) {
    return renderableParts;
  }

  return [...renderableParts].sort((left, right) =>
    compareStreamPosition(
      (left as OrderedAssistantContentPart).streamPosition,
      (right as OrderedAssistantContentPart).streamPosition,
    ));
};

export const getOrderedMessageBlocks = (
  message: StoredMessage,
): ReadonlyArray<OrderedMessageBlock> => {
  const attachmentParts = getAttachmentParts(message);
  const renderableParts = getRenderableParts(message);

  if (message.role !== "assistant") {
    const blocks: Array<OrderedMessageBlock> = [];
    if (attachmentParts.length > 0) {
      blocks.push({
        type: "attachments",
        parts: attachmentParts,
      });
    }

    for (const part of renderableParts) {
      if (part.type !== "text") {
        continue;
      }

      blocks.push({
        type: "text",
        text: part.text,
      });
    }

    return blocks;
  }

  const blocks: Array<OrderedMessageBlock> = [];
  if (attachmentParts.length > 0) {
    blocks.push({
      type: "attachments",
      parts: attachmentParts,
    });
  }

  for (const part of renderableParts) {
    if (part.type === "text") {
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

  return blocks;
};
