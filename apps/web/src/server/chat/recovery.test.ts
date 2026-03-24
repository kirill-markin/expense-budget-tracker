import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";
import {
  QUERY_DATABASE_RECOVERY_NOTE,
  QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
} from "@/server/chat/openai/recovery";
import { recoverInterruptedChatConversationWithDeps } from "./recovery";

test("recoverInterruptedChatConversationWithDeps persists local recovery after closing pending calls", async () => {
  const persistCalls: Array<Readonly<Record<string, unknown>>> = [];

  const result = await recoverInterruptedChatConversationWithDeps(
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      conversationId: "conv-1",
    },
    {
      createClient: (): OpenAI => ({}) as OpenAI,
      recoverInterruptedQueryDatabaseCalls: async (): Promise<{
        recoveredCallIds: ReadonlyArray<string>;
        recoveryNoteText: string | null;
        recoveryToolOutputText: string;
      }> => ({
        recoveredCallIds: ["call-1"],
        recoveryNoteText: QUERY_DATABASE_RECOVERY_NOTE,
        recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
      }),
      persistRecoveredChatConversation: async (_userId, _workspaceId, params): Promise<void> => {
        persistCalls.push(params as Readonly<Record<string, unknown>>);
      },
    },
  );

  assert.deepEqual(result, {
    recoveredCallIds: ["call-1"],
    recoveryNoteText: QUERY_DATABASE_RECOVERY_NOTE,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  });
  assert.deepEqual(persistCalls, [{
    sessionId: "session-1",
    recoveredCallIds: ["call-1"],
    recoveryNoteText: QUERY_DATABASE_RECOVERY_NOTE,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  }]);
});

test("recoverInterruptedChatConversationWithDeps is a no-op when there is no conversation ID", async () => {
  let recoverCalls = 0;
  let persistCalls = 0;

  const result = await recoverInterruptedChatConversationWithDeps(
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      conversationId: null,
    },
    {
      createClient: (): OpenAI => ({}) as OpenAI,
      recoverInterruptedQueryDatabaseCalls: async (): Promise<{
        recoveredCallIds: ReadonlyArray<string>;
        recoveryNoteText: string | null;
        recoveryToolOutputText: string;
      }> => {
        recoverCalls += 1;
        return {
          recoveredCallIds: [],
          recoveryNoteText: null,
          recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
        };
      },
      persistRecoveredChatConversation: async (): Promise<void> => {
        persistCalls += 1;
      },
    },
  );

  assert.equal(recoverCalls, 0);
  assert.equal(persistCalls, 0);
  assert.deepEqual(result, {
    recoveredCallIds: [],
    recoveryNoteText: null,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  });
});

test("recoverInterruptedChatConversationWithDeps skips local persistence when no pending calls were recovered", async () => {
  let persistCalls = 0;

  const result = await recoverInterruptedChatConversationWithDeps(
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      conversationId: "conv-1",
    },
    {
      createClient: (): OpenAI => ({}) as OpenAI,
      recoverInterruptedQueryDatabaseCalls: async (): Promise<{
        recoveredCallIds: ReadonlyArray<string>;
        recoveryNoteText: string | null;
        recoveryToolOutputText: string;
      }> => ({
        recoveredCallIds: [],
        recoveryNoteText: null,
        recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
      }),
      persistRecoveredChatConversation: async (): Promise<void> => {
        persistCalls += 1;
      },
    },
  );

  assert.equal(persistCalls, 0);
  assert.deepEqual(result, {
    recoveredCallIds: [],
    recoveryNoteText: null,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  });
});
