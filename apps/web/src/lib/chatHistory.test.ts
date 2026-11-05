import assert from "node:assert/strict";
import test from "node:test";
import { applyAssistantError, type StoredMessage } from "@/lib/chatHistory";

const ERROR_TEXT = "The model request failed.";
const ERROR_TIMESTAMP = 3_000;

const userMessage: StoredMessage = {
  role: "user",
  content: [{ type: "text", text: "Show my balances." }],
  timestamp: 1_000,
  isError: false,
  isStopped: false,
};

const errorMessage: StoredMessage = {
  role: "assistant",
  content: [{ type: "text", text: ERROR_TEXT }],
  timestamp: ERROR_TIMESTAMP,
  isError: true,
  isStopped: false,
};

test("an assistant reply followed by an error loses its finish time", (): void => {
  const reply: StoredMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Checking." }],
    timestamp: 2_000,
    isError: false,
    isStopped: false,
    completedAt: 2_500,
  };

  assert.deepEqual(applyAssistantError([userMessage, reply], ERROR_TEXT, ERROR_TIMESTAMP), [
    userMessage,
    {
      role: "assistant",
      content: reply.content,
      timestamp: 2_000,
      isError: false,
      isStopped: false,
    },
    errorMessage,
  ]);
});

test("an empty assistant reply becomes the error without a finish time", (): void => {
  const reply: StoredMessage = {
    role: "assistant",
    content: [],
    timestamp: 2_000,
    isError: false,
    isStopped: true,
    completedAt: 2_500,
  };

  assert.deepEqual(applyAssistantError([userMessage, reply], ERROR_TEXT, ERROR_TIMESTAMP), [
    userMessage,
    {
      role: "assistant",
      content: errorMessage.content,
      timestamp: 2_000,
      isError: true,
      isStopped: false,
    },
  ]);
});

test("an error after a user message is appended", (): void => {
  assert.deepEqual(applyAssistantError([userMessage], ERROR_TEXT, ERROR_TIMESTAMP), [
    userMessage,
    errorMessage,
  ]);
});
