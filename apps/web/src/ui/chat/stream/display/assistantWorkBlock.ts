import type { OrderedMessageBlock } from "./messageContentOrder";

type AttachmentsBlock = Extract<OrderedMessageBlock, Readonly<{ type: "attachments" }>>;
type TextBlock = Extract<OrderedMessageBlock, Readonly<{ type: "text" }>>;
type WorkBlockItem = Exclude<OrderedMessageBlock, AttachmentsBlock>;

/** `work` is empty when the reply made no tool call and produced no reasoning. */
export type AssistantWorkBlockSplit = Readonly<{
  attachments: ReadonlyArray<AttachmentsBlock>;
  work: ReadonlyArray<WorkBlockItem>;
  answer: ReadonlyArray<TextBlock>;
}>;

export type DurationParts = Readonly<{
  hours: number;
  minutes: number;
  seconds: number;
}>;

/**
 * Work is every non-attachment block up to and including the last tool call or
 * reasoning summary; the text after it is the final answer.
 */
export const splitAssistantWorkBlock = (
  blocks: ReadonlyArray<OrderedMessageBlock>,
): AssistantWorkBlockSplit => {
  const attachments = blocks.filter((block): block is AttachmentsBlock =>
    block.type === "attachments");
  const contentBlocks = blocks.filter((block): block is WorkBlockItem =>
    block.type !== "attachments");
  const lastWorkIndex = contentBlocks.findLastIndex((block) =>
    block.type === "tool_call" || block.type === "reasoning_summary");

  return {
    attachments,
    work: contentBlocks.slice(0, lastWorkIndex + 1),
    answer: contentBlocks.slice(lastWorkIndex + 1).filter((block): block is TextBlock =>
      block.type === "text"),
  };
};

/** Clamped at zero: the start and end may come from different clocks. */
export const getElapsedMs = (startMs: number, endMs: number): number =>
  Math.max(0, endMs - startMs);

export const getDurationParts = (durationMs: number): DurationParts => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(
      `Work duration must be a finite non-negative number of milliseconds, got ${durationMs}.`,
    );
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
};
