"use client";

import type { StoredMessage } from "@/ui/hooks/useChatHistory";
import type { ChatRunState } from "./streamRecovery";

export type ChatSessionSnapshot = Readonly<{
  sessionId: string;
  runState: ChatRunState;
  updatedAt: number;
  mainContentInvalidationVersion: number;
  messages: ReadonlyArray<StoredMessage>;
}>;
