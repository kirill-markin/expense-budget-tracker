import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "@/server/chat/types";
import {
  buildInput,
  getLatestUserFileAttachments,
  getSpreadsheetAttachmentFileNames,
} from "./input";

test("getLatestUserFileAttachments returns only files from the latest user message", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Seen" }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Please inspect this" },
        { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "bmV3" },
        { type: "image", mediaType: "image/png", base64Data: "aW1hZ2U=" },
      ],
    },
  ];

  assert.deepEqual(getLatestUserFileAttachments(messages), [
    { type: "file", fileName: "report.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64Data: "bmV3" },
  ]);
});

test("getSpreadsheetAttachmentFileNames recognizes spreadsheets by extension and media type", () => {
  const attachments = [
    { type: "file", fileName: "expenses.csv", mediaType: "application/octet-stream", base64Data: "MQ==" },
    { type: "file", fileName: "notes.txt", mediaType: "text/plain", base64Data: "Mg==" },
    { type: "file", fileName: "balances", mediaType: "text/csv", base64Data: "Mw==" },
  ] as const;

  assert.deepEqual(getSpreadsheetAttachmentFileNames(attachments), ["expenses.csv", "balances"]);
});

test("buildInput keeps raw attachments only on the latest user message", () => {
  const messages: ReadonlyArray<ChatMessage> = [
    {
      role: "user",
      content: [
        { type: "text", text: "First" },
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Seen" }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Latest" },
        { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
      ],
    },
  ];

  assert.deepEqual(buildInput(messages), [
    {
      role: "user",
      content: "First\n[attached file: old.csv]",
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "Seen" }],
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Latest" },
        { type: "input_file", file: "data:text/csv;base64,bmV3", filename: "new.csv" },
      ],
    },
  ]);
});
