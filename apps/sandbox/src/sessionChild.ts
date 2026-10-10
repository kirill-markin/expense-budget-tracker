/**
 * The child side of one chat session's process.
 *
 * Every command of a session runs here, and the process is killed before a
 * different session's command is served, so no module scope, V8 heap, python
 * or sqlite worker is ever shared across sessions.
 */
import { runChatSandboxBash } from "./bashOperation.js";
import type { ChatSandboxBashRequest, ChatSandboxBashResponse } from "./contract.js";

/** Set on the forked process only, which is how the same file becomes the child's main. */
export const SANDBOX_CHILD_ENV_VAR = "CHAT_SANDBOX_SESSION_CHILD";

export type SandboxChildCommand = Readonly<{
  kind: "bash";
  request: ChatSandboxBashRequest;
  deadlineEpochMs: number;
}>;

export type SandboxChildMessage =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "result"; response: ChatSandboxBashResponse }>
  | Readonly<{ kind: "failure"; error: string }>;

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export const startSandboxChild = (): void => {
  const channel = process.send?.bind(process);
  if (channel === undefined) {
    throw new Error(
      `${SANDBOX_CHILD_ENV_VAR} is set but this process has no IPC channel, so it cannot serve a chat session`,
    );
  }

  const send = (message: SandboxChildMessage): void => {
    channel(message);
  };

  // The parent sends one command at a time and waits for its answer, so there
  // is no queue to manage here.
  process.on("message", (message: SandboxChildCommand): void => {
    void runChatSandboxBash(message.request, message.deadlineEpochMs).then(
      (response) => {
        send({ kind: "result", response });
      },
      (error: unknown) => {
        send({ kind: "failure", error: describeError(error) });
      },
    );
  });

  send({ kind: "ready" });
};
