import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import type { ChatMessage, ContentPart } from "@/server/chat/types";
import { buildChatCompletionInput } from "./input";

type InputMessage = OpenAI.Responses.EasyInputMessage & Readonly<{
  content: OpenAI.Responses.ResponseInputMessageContentList;
}>;

const encodeText = (
  value: string,
): string =>
  Buffer.from(value, "utf8").toString("base64");

const DOCX_BASE64 = "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";

const findMessageAt = (
  input: Awaited<ReturnType<typeof buildChatCompletionInput>>,
  index: number,
): InputMessage => {
  const item = input[index];
  if (item === undefined || !isInputMessage(item)) {
    throw new Error(`Expected message at index ${String(index)}`);
  }
  return item;
};

const isInputMessage = (
  item: OpenAI.Responses.ResponseInputItem,
): item is InputMessage =>
  item.type === "message"
  && "content" in item
  && Array.isArray(item.content);

const isInputFilePart = (
  part: OpenAI.Responses.ResponseInputMessageContentList[number],
): part is Extract<OpenAI.Responses.ResponseInputMessageContentList[number], { type: "input_file" }> =>
  part.type === "input_file";

const isInputTextPart = (
  part: OpenAI.Responses.ResponseInputMessageContentList[number],
): part is Extract<OpenAI.Responses.ResponseInputMessageContentList[number], { type: "input_text" }> =>
  part.type === "input_text";

test("buildChatCompletionInput preserves prior attached files as full content on later turns", async () => {
  const localMessages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "text/csv",
          base64Data: encodeText("date,amount\n2026-03-24,10"),
          fileName: "statement.csv",
        },
        { type: "text", text: "Import this statement." },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I checked the CSV." }],
    },
  ];

  const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: "Continue the import." }];
  const input = await buildChatCompletionInput(localMessages, turnInput, "UTC");
  const previousUserMessage = findMessageAt(input, 1);

  assert.equal(previousUserMessage.role, "user");
  assert.ok(
    Array.isArray(previousUserMessage.content)
    && previousUserMessage.content.some((part) =>
      isInputFilePart(part) && part.filename === "statement.csv"),
  );
  assert.ok(
    Array.isArray(previousUserMessage.content)
    && previousUserMessage.content.some((part) =>
      isInputTextPart(part) && part.text.includes("date,amount")),
  );
});

test("buildChatCompletionInput does not duplicate the current user turn when it is already persisted", async () => {
  const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: "Use best guess." }];
  const localMessages: ReadonlyArray<ChatMessage> = [
    {
      role: "assistant",
      content: [{ type: "text", text: "Ready when you are." }],
    },
    {
      role: "user",
      content: turnInput,
    },
  ];

  const input = await buildChatCompletionInput(localMessages, turnInput, "UTC");
  const userMessages = input.filter((item): item is InputMessage =>
    isInputMessage(item) && item.role === "user");

  assert.equal(userMessages.length, 1);
  const onlyUserMessage = userMessages[0];
  assert.ok(
    Array.isArray(onlyUserMessage.content)
    && onlyUserMessage.content.some((part) =>
      isInputTextPart(part) && part.text === "Use best guess."),
  );
});

test("buildChatCompletionInput keeps attachment turns from the whole session instead of trimming to a fixed window", async () => {
  const localMessages: Array<ChatMessage> = [{
    role: "user",
    content: [
      {
        type: "file",
        mediaType: "text/plain",
        base64Data: encodeText("oldest attachment"),
        fileName: "oldest.txt",
      },
    ],
  }];

  for (let index = 0; index < 30; index += 1) {
    localMessages.push({
      role: index % 2 === 0 ? "assistant" : "user",
      content: [{ type: "text", text: `message-${String(index)}` }],
    });
  }

  const input = await buildChatCompletionInput(localMessages, [{ type: "text", text: "latest" }], "UTC");

  assert.ok(
    input.some((item) =>
      isInputMessage(item)
      && item.content.some((part) =>
        isInputFilePart(part) && part.filename === "oldest.txt")),
  );
});

test("buildChatCompletionInput expands DOCX attachments to text while keeping the original file", async () => {
  const localMessages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          base64Data: DOCX_BASE64,
          fileName: "notes.docx",
        },
      ],
    },
  ];

  const input = await buildChatCompletionInput(localMessages, [{ type: "text", text: "continue" }], "UTC");
  const previousUserMessage = findMessageAt(input, 1);

  assert.ok(
    previousUserMessage.content.some((part) =>
      isInputTextPart(part) && part.text.includes("Hello DOCX")),
  );
  assert.ok(
    previousUserMessage.content.some((part) =>
      isInputFilePart(part) && part.filename === "notes.docx"),
  );
});
