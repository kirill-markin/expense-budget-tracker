import type { FileContentPart } from "@/server/chat/types";
import { quoteUntrustedSandboxValue } from "../../../../../../sandbox/src/contract";

/**
 * What a document is in a prompt: a file of the session the model opens with
 * `bash`. Never its bytes - the per-turn manifest names the same path, and the
 * sandbox mounts it there.
 *
 * Here rather than beside the input that sends it, because history sizing
 * charges this exact string. Nothing caps how many documents one turn carries,
 * and a name may be a hundred characters of any script, so a constant standing
 * for the line would under-charge the input by as much as the window holds.
 */
export const buildChatFilePromptText = (
  part: FileContentPart,
): string =>
  `Attached file ${quoteUntrustedSandboxValue(part.path)}, ${String(part.sizeBytes)} bytes. `
  + "Read it with the bash tool; this message does not carry its contents.";
