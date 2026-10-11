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
 */
import type { Context } from "aws-lambda";
import {
  parseChatSandboxBashRequest,
  parseChatSandboxPdfPageRequest,
  readChatSandboxOperation,
  type ChatSandboxBashResponse,
  type ChatSandboxPdfPageResponse,
} from "./contract.js";
import { runChatSandboxPdfPage } from "./pdfPageOperation.js";
import { runSessionCommand } from "./sessionProcess.js";

/**
 * Slice of the Lambda timeout kept for returning the response, which is also
 * the deadline every pre-signed transfer of this invocation is bound to.
 */
const RESPONSE_MARGIN_MS = 3_000;

export const handler = async (
  event: unknown,
  context: Context,
): Promise<ChatSandboxBashResponse | ChatSandboxPdfPageResponse> => {
  // Read before it is validated, because each operation is validated as itself:
  // the pre-signed URLs a `bash` request carries are not the ones a document
  // operation carries, and only the matching schema knows which are required.
  const operation = readChatSandboxOperation(event);
  const deadlineEpochMs = Date.now() + context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;

  switch (operation) {
    case "bash":
      // The only operation that runs in a child process, because it is the only
      // one that leaves state behind: see sessionProcess.ts.
      return runSessionCommand(parseChatSandboxBashRequest(event), deadlineEpochMs);
    case "pdf_page":
      return runChatSandboxPdfPage(parseChatSandboxPdfPageRequest(event), deadlineEpochMs);
  }
};
