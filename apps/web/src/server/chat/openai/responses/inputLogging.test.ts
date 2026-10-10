import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_SENT_INPUT_BUDGET_TOKENS } from "@/lib/chatModels";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";

/**
 * Separate from `input.test.ts` because the logger has to be mocked before the
 * module under test is first imported, and that file imports it at the top.
 */
const TURN_TEXT_CHARACTERS = 6_000;

const createStoredSession = (
  turnCount: number,
): ReadonlyArray<ServerChatMessage> =>
  Array.from({ length: turnCount }).flatMap((_, turnIndex) => [
    {
      role: "user" as const,
      content: [{
        type: "text" as const,
        text: `Turn ${String(turnIndex)} question ${"q".repeat(TURN_TEXT_CHARACTERS)}`,
      }],
    },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: `Turn ${String(turnIndex)} answer` }],
      openaiItems: [{
        type: "message" as const,
        role: "assistant" as const,
        status: "completed" as const,
        content: [{
          type: "output_text" as const,
          text: `Turn ${String(turnIndex)} answer ${"a".repeat(TURN_TEXT_CHARACTERS)}`,
          annotations: [],
        }],
      }],
    },
  ]);

test("buildChatCompletionInput reports the bound it applied", async (t): Promise<void> => {
  // The only signal an operator has that a session is being trimmed, and what
  // that cost: nothing else in the request records that history was dropped.
  const events: Array<Readonly<Record<string, unknown>>> = [];

  t.mock.module("@/server/logger", {
    namedExports: {
      log: (event: Readonly<Record<string, unknown>>): void => {
        events.push(event);
      },
    },
  });

  const { buildChatCompletionInput } = await import(
    "@/server/chat/openai/responses/input"
  );
  const localMessages = createStoredSession(40);
  const { items } = await buildChatCompletionInput(
    localMessages,
    [{ type: "text", text: "Continue" }],
    "Europe/Madrid",
    "session-1",
    "req-1",
  );
  const renderedInput = JSON.stringify(items);

  const boundedEvents = events.filter((event) => event.action === "history_bounded");
  assert.equal(boundedEvents.length, 1);
  const [boundedEvent] = boundedEvents;
  assert.equal(boundedEvent?.domain, "chat");
  assert.equal(boundedEvent?.vendor, "openai");
  assert.equal(boundedEvent?.requestId, "req-1");
  assert.equal(boundedEvent?.sessionId, "session-1");
  assert.equal(boundedEvent?.boundary, "window");
  assert.equal(boundedEvent?.budgetTokens, CHAT_SENT_INPUT_BUDGET_TOKENS);
  // Grounded against the input that was actually built, not against the other
  // fields of the same return value: the count it reports as dropped has to be
  // the count of leading messages missing from the request.
  const droppedMessages = Number(boundedEvent?.droppedMessages);
  assert.ok(droppedMessages > 0);
  const renderedTurns = localMessages.map((_, index) =>
    renderedInput.includes(`Turn ${String(Math.floor(index / 2))} question`)
    || renderedInput.includes(`Turn ${String(Math.floor(index / 2))} answer`));
  assert.equal(renderedTurns.slice(0, droppedMessages).some(Boolean), false);
  assert.equal(renderedTurns.slice(droppedMessages).every(Boolean), true);
  // The bound removed something real, measured against the unbounded size of the
  // same stored session.
  assert.ok(
    Number(boundedEvent?.unboundedSentInputTokens) > CHAT_SENT_INPUT_BUDGET_TOKENS,
  );
  assert.ok(
    Number(boundedEvent?.sentInputTokens) < Number(boundedEvent?.unboundedSentInputTokens),
  );
});
