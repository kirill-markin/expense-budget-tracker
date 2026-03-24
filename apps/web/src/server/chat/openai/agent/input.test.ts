import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, ContentPart } from "@/server/chat/types";
import {
  buildInput,
  getAllUserFileAttachments,
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

test("getAllUserFileAttachments returns unique files across user history", () => {
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
        { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
        { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
      ],
    },
  ];

  assert.deepEqual(getAllUserFileAttachments(messages), [
    { type: "file", fileName: "old.csv", mediaType: "text/csv", base64Data: "b2xk" },
    { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
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

test("buildInput converts only the current user turn into Agent input items", () => {
  const content: ReadonlyArray<ContentPart> = [
    { type: "text", text: "Latest" },
    { type: "file", fileName: "new.csv", mediaType: "text/csv", base64Data: "bmV3" },
  ];

  assert.deepEqual(buildInput(content), [{
    role: "user",
    type: "message",
    content: [
      { type: "input_text", text: "Latest" },
      { type: "input_file", file: "data:text/csv;base64,bmV3", filename: "new.csv" },
    ],
  }]);
});
