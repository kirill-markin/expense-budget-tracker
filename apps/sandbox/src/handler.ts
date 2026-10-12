/**
 * Lambda entry point for the chat sandbox.
 *
 * The function is invoked only by the web task, which is the component that
 * decides what this sandbox may touch: the request carries one pre-signed GET
 * per file of one chat session and a fixed number of pre-signed PUT slots. The
 * execution role itself grants nothing beyond this function's own log stream,
 * the function has no VPC role to speak for it, and every pre-signed URL is
 * checked against the deployment's object-storage hosts, so an unvalidated
 * request can reach nothing.
 *
 * Nothing untrusted is parsed in this process. Every operation runs in a forked
 * child - `bash` in one per chat session, `prepare` and `pdf_page` in one per
 * job - because a warm execution environment reuses this supervisor across
 * invocations, and therefore across the chat sessions of different users. What
 * is left here is reading the payload and choosing which runner it reaches.
 */
import type { Context } from "aws-lambda";
import {
  parseChatSandboxBashRequest,
  parseChatSandboxPdfPageRequest,
  parseChatSandboxPrepareRequest,
  readChatSandboxOperation,
  type ChatSandboxBashResponse,
  type ChatSandboxPdfPageResponse,
  type ChatSandboxPrepareResponse,
} from "./contract.js";
import {
  runChatSandboxPdfPageInChild,
  runChatSandboxPrepare,
  type ChatSandboxPdfPageRunner,
  type ChatSandboxPrepareRunner,
} from "./prepareProcess.js";
import { runSessionCommand, type SessionCommandRunner } from "./sessionProcess.js";

/**
 * Slice of the Lambda timeout kept for returning the response, which is also
 * the deadline every pre-signed transfer of this invocation is bound to.
 */
const RESPONSE_MARGIN_MS = 3_000;

export type ChatSandboxAnswer =
  | ChatSandboxBashResponse
  | ChatSandboxPrepareResponse
  | ChatSandboxPdfPageResponse;

/**
 * The three runners this entry point dispatches to, as ports.
 *
 * Injected for one reason, and it is a reason about what can be tested rather
 * than about what production needs: every operation now runs in a forked child,
 * and no production child can be forked from a suite, because each spec starts
 * a plain `node` on a module path that is a bundle in the Lambda and a
 * TypeScript file in a checkout. Each runner is driven through a real child in
 * its own suite - sessionProcess.test.ts and prepareProcess.test.ts - so what
 * is left for this one is the only decision this file makes: which runner a
 * payload reaches, parsed as itself, under a deadline that keeps the response
 * margin back.
 */
export type ChatSandboxRunners = Readonly<{
  bash: SessionCommandRunner;
  prepare: ChatSandboxPrepareRunner;
  pdfPage: ChatSandboxPdfPageRunner;
}>;

export const createChatSandboxHandler = (
  runners: ChatSandboxRunners,
): ((event: unknown, context: Context) => Promise<ChatSandboxAnswer>) =>
  async (event: unknown, context: Context): Promise<ChatSandboxAnswer> => {
    // Read before it is validated, because each operation is validated as
    // itself: the pre-signed URLs a `bash` request carries are not the ones a
    // document operation carries, and only the matching schema knows which are
    // required.
    const operation = readChatSandboxOperation(event);
    const deadlineEpochMs = Date.now() + context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;

    switch (operation) {
      case "bash":
        // The only operation whose child leaves state behind, because it is
        // kept for that session's next command: see sessionProcess.ts.
        return runners.bash(parseChatSandboxBashRequest(event), deadlineEpochMs);
      case "prepare":
        // A one-shot child instead, killed whatever it answered: see
        // prepareProcess.ts.
        return runners.prepare(parseChatSandboxPrepareRequest(event), deadlineEpochMs);
      case "pdf_page":
        // The same one-shot child as a `prepare`, for the same reason and with
        // its own answer for a child that died: prepareProcess.ts again.
        return runners.pdfPage(parseChatSandboxPdfPageRequest(event), deadlineEpochMs);
    }
  };

export const handler = createChatSandboxHandler({
  bash: runSessionCommand,
  prepare: runChatSandboxPrepare,
  pdfPage: runChatSandboxPdfPageInChild,
});
