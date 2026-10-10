/**
 * Sizes the replayed chat history in real input tokens and picks where the
 * replay may start, so the first call of a turn cannot send more than
 * `CHAT_SENT_INPUT_BUDGET_TOKENS`.
 *
 * Only that first call is bounded here. The later calls of the same run append
 * their tool outputs and reasoning to the same base input, which this module
 * neither sees nor can predict; what holds them is the provider-side
 * `CHAT_COMPACT_THRESHOLD_TOKENS` the request asks for.
 *
 * The quantity bounded is the whole input of that first call - the fixed reserve
 * for the instructions, tool schemas and clock, plus the replayed history, plus
 * the current user turn - never the history alone.
 *
 * Measured turns carry `usage.input_tokens` and `usage.output_tokens` of the
 * last model call of the turn. The pair is what makes the attribution exact:
 * the input of that call cannot contain the items the same call produced, so
 * `inputTokens` alone always understates the stored history by the newest
 * assistant turn. The two together cover the stored history through that
 * message and no further, which keeps the suffix total at any measured boundary
 * equal to the call's real measured input however the segment is split inside.
 *
 * Unmeasured turns fall back to a character and attachment estimate that reads
 * high on purpose, and sizes exactly what replay sends: `openaiItems` for an
 * assistant turn, `content` for a user turn, never both.
 *
 * A measurement is used whichever of the routed models produced it, but only
 * while it still leaves tokens for the messages it newly covers. A compacted
 * call reports its small post-compaction input, so a later measurement over a
 * superset input can legitimately come in below its predecessor; sizing those
 * messages from such a measurement would weight a whole turn at nothing, so they
 * keep their estimates instead. An already assigned weight is never rewritten,
 * which keeps the series append-only: the size of a stored message is fixed when
 * it is first sized, so identical history always yields the identical replay
 * boundary.
 *
 * That raise-only rule is not what makes a cross-model measurement safe, since a
 * lower measurement is adopted as it stands whenever it is still positive. What
 * makes it safe is that `CHAT_MODEL_ID` and `CHAT_FALLBACK_MODEL_ID`, which
 * `modelRouting.ts` can switch between mid-session, are of one family and count
 * with the same `o200k` tokenizer, so no model id has to be persisted beside a
 * measurement. A model on another tokenizer family would need one.
 *
 * The replay boundary is NOT monotone, and three attempts to make it so each
 * produced a P1 - permanent truncation of healthy sessions, then oscillation -
 * so do not reintroduce a floor here. What guards against attempt 2's thrash is
 * the append-only weight rule above, and it is now the only thing that does: a
 * weight is fixed when first assigned, so a message's size changes at most once,
 * from estimate to measurement. That bounds backwards motion at one step per
 * measured turn, converging forward. Stepping back is safe because weights are
 * never negative - the sent input is non-increasing in the start index - and the
 * budget is re-checked, so an earlier start is only ever taken when the larger
 * history genuinely fits. The reasoning is kept in full at
 * `selectChatHistoryWindowStart`.
 *
 *
 * The invariant that governs every number below: **sizing may never claim a
 * message fits when its real content could exceed the budget.**
 *
 * So nothing here is scaled down to keep a message replayable. A quantity this
 * module can only bound - a container nobody could read, a native image, a
 * rendered PDF page - is charged at that bound in full, and a quantity it can
 * count is counted. The consequence is accepted deliberately: a message whose
 * attachments are larger than the budget leaves no cut that reaches through it,
 * so the window cuts past it and the history before it is lost.
 *
 * The alternative was measured and is worse. Ceilinging such a message at half
 * the budget made sizing report that it fit. One 500,000 character text
 * attachment, every one of them charged the same 60,000 tokens:
 *
 *   dense CSV, this product's own import format    250,021 real   2.08x budget
 *   private use area, DOCX symbol-font text      1,000,000 real   8.33x budget
 *   CJK compatibility ideographs, U+0801         1,500,000 real  12.50x budget
 *
 * So the under-charge reached 25x per message, and the headline case is the
 * ordinary one: a single large bank-export CSV sitting in the replay window puts
 * one call at twice the budget by itself, in a product built on tabular
 * financial data. Two CJK attachments in one message reported 114,793 and really
 * sent 796,814. Such a call returns `context_length_exceeded`, an errored turn
 * stores no measurement, and sizing is deterministic - so the next turn computes
 * the same plan and fails the same way. The provider-side compaction and "the
 * turn's own measurement corrects it" that justified the ceiling do not apply on
 * exactly the errored, cancelled and tool-limit paths where such a call lands.
 * Losing history is recoverable by asking again; a session that cannot answer at
 * all is not.
 *
 * Note the contradiction a ceiling creates, because it is what stops someone
 * reintroducing one for tidiness: `NON_ASCII_TOKENS_PER_CHARACTER` was raised to
 * 3 precisely to stop under-charging the private use area and the CJK
 * compatibility blocks, and a ceiling then throws that result away for exactly
 * the same content. The two pull in opposite directions, and the bound is the
 * half that keeps the window honest.
 
 */
import {
  CHAT_SENT_INPUT_BUDGET_TOKENS,
  CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS,
} from "@/lib/chatModels";
import {
  ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS,
  decodeUtf8File,
  isDocxAttachment,
  isTextFileAttachment,
  isWorkbookAttachment,
} from "@/lib/chatAttachments";
import {
  findLatestChatCompactionBoundary,
  type ServerChatMessage,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import type { ContentPart, FileContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";

/**
 * Characters per token of ASCII text. Not a proven floor over ASCII - these are
 * below it: random ASCII with control codes 1.18, percent-encoded payloads 1.33,
 * uniform random printable ASCII 1.36, generated passwords 1.43. What it is, is
 * a bound with room over every shape this product actually replays: bank
 * statement CSV 1.95 (1.4x), an amounts-only column 1.50, uuids 1.58, a CSV of
 * floats 1.61, random hex 1.77, markdown tables 2.11, JSON tool output 3.20,
 * SQL 3.40, English prose 5.43 (3.9x).
 *
 * The residual is therefore real but narrow: a message consisting of random
 * high-entropy ASCII - a pasted key dump - reads up to 19% low, and its turn's
 * own measurement corrects it. Lowering the constant to a true ASCII floor would
 * multiply the over-charge at the sparse end, which is the expensive direction:
 * an over-charged estimate is what drops a session's history early, and it
 * recovers only when a measurement replaces it.
 */
const ASCII_CHARS_PER_TOKEN = 1.4;

/**
 * Tokens per non-ASCII character. No characters-per-token constant can bound
 * these: `o200k` spends more than one token on many of them, so their rate is
 * the wrong way up.
 *
 * Scanned over every BMP codepoint, repeated to remove context effects, the cost
 * peaks at exactly 3.000 tokens per character (U+0801), and whole blocks sit
 * near it: CJK compatibility ideographs mean 2.986, Yi syllables 2.985, CJK
 * extension A 2.980, CJK radicals 2.969, and the Private Use Area 2.910. That
 * last one is ordinary content rather than an exotic case - it is where symbol
 * font text from a DOCX lands - so 2.5 was not a bound, it read 14% low over a
 * whole block.
 *
 * Astral characters are safe without special handling: `String.length` counts a
 * surrogate pair as two, which over-charges a four-byte character rather than
 * under-charging it. Lone surrogates, U+FFFD, combining marks, zero-width
 * joiners and variation selectors were checked and are all under this rate.
 */
const NON_ASCII_TOKENS_PER_CHARACTER = 3;

/**
 * Characters per token of base64, measured at 1.00 for repetitive payloads and
 * 1.3 to 1.5 for dense ones. An opaque attachment replays as a base64 data URL
 * and an encrypted reasoning or compaction payload is base64 too, so both are
 * charged at this rate rather than at the text rate.
 */
const BASE64_CHARS_PER_TOKEN = 1;

/**
 * The `[truncated: ...]` line replay appends past the extracted-text cap, plus
 * the fence it closes - charged on top of the cap, which is where it is sent.
 */
const ATTACHMENT_TRUNCATION_NOTICE_TOKENS = 64;

/**
 * JSON envelope, role and type markers of one replayed item or content part,
 * plus the rendered prefixes replay adds around it - `Tool call:`, `Status:`,
 * `Input:`, `Output:`, `Reasoning summary:` and the quoting of the JSON itself.
 * Measured at 10 to 20 tokens for a tool call, so 8 was under.
 */
const ITEM_ENVELOPE_TOKENS = 24;

/**
 * One native image. OpenAI prices an image by its detail tiling, which peaks
 * near 1.5k tokens once the long edge is clamped; the stored part carries no
 * dimensions, so this is an upper bound rather than a guess at them.
 *
 * Both image constants are assumptions about the configured model family rather
 * than general truths: the patch cap and the per-image multiplier are
 * model-specific, and the mini and nano tiers scale image tokens on top of them.
 * They hold for `CHAT_MODEL_ID` and `CHAT_FALLBACK_MODEL_ID`; routing the chat
 * to another family means re-deriving them.
 */
const IMAGE_TOKENS = 2_000;

/** One rendered PDF page image, already clamped to `PDF_MAXIMUM_LONG_EDGE`. */
const PDF_PAGE_IMAGE_TOKENS = 1_500;

/**
 * The fixed instructions replay wraps around every PDF page - what the page is,
 * that the text and the image are two views of it, and that they are not two
 * transactions. Around 450 characters per page, so about 90 tokens.
 */
const PDF_PAGE_PROMPT_HEADER_TOKENS = 120;

export type ChatHistorySizing = Readonly<{
  /** Tokens of the history ahead of each message index, ending with the total. */
  prefixTokens: ReadonlyArray<number>;
  totalTokens: number;
}>;

/**
 * Why the replay starts where it does. `none` replays the whole stored history,
 * `compaction` starts at the newest stored compaction item, `window` trims the
 * oldest turns away, `stale_compaction` means the history from that compaction
 * item onward no longer fit the budget, so the item was dropped and the window
 * applied instead.
 */
export type ChatHistoryBoundary =
  | "none"
  | "compaction"
  | "window"
  | "stale_compaction";

export type ChatHistoryReplayPlan = Readonly<{
  startIndex: number;
  /**
   * Item index inside the first replayed message at which the replay starts, or
   * `null` when the replay does not start at a compaction item. A compaction
   * item is replayed only in that position; one found anywhere else in the
   * replayed range stands for context that is being resent in full, so it is
   * dropped.
   */
  compactionItemIndex: number | null;
  boundary: ChatHistoryBoundary;
  droppedMessages: number;
  /** Input one call would send with no bound applied, and with this plan. */
  unboundedSentInputTokens: number;
  sentInputTokens: number;
}>;

/**
 * Counted with an index loop on purpose: this runs over every replayed character
 * of every turn, and both `[...text]` and a regex replace allocate a copy of the
 * whole history to count it. A surrogate pair counts as two, which over-charges
 * an astral character rather than under-charging it.
 */
const countNonAsciiCharacters = (
  text: string,
): number => {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 127) {
      count += 1;
    }
  }

  return count;
};

const estimateTextTokens = (
  text: string,
): number => {
  const nonAsciiCharacters = countNonAsciiCharacters(text);

  return Math.ceil(
    (text.length - nonAsciiCharacters) / ASCII_CHARS_PER_TOKEN
    + nonAsciiCharacters * NON_ASCII_TOKENS_PER_CHARACTER,
  );
};

/**
 * Tokens of a quantity of characters nobody has in hand - a byte count or a cap.
 * Charged at the ASCII rate, the only one a bare count can be charged at.
 */
const estimateCharacterTokens = (
  characters: number,
): number =>
  Math.ceil(characters / ASCII_CHARS_PER_TOKEN);

const estimateBase64Tokens = (
  base64Data: string,
): number =>
  Math.ceil(base64Data.length / BASE64_CHARS_PER_TOKEN);

const estimateBase64ByteLength = (
  base64Data: string,
): number =>
  Math.ceil((base64Data.length * 3) / 4);

/**
 * Extractable formats whose stored bytes are a container rather than the text
 * they yield: a workbook or a DOCX is read through a ZIP or BIFF reader, so its
 * bytes bound nothing about the text replay sends. The predicates come from the
 * attachment policy itself, so a format added there is covered here too.
 */
const isContainerExtractableAttachment = (
  part: FileContentPart,
): boolean =>
  isWorkbookAttachment(part) || isDocxAttachment(part);

/**
 * An extractable attachment replays as extracted text, capped at
 * `ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS`, and an opaque one replays as
 * its own bytes. Extraction is asynchronous and sizing is not, so the decoded
 * byte length stands in for the extracted text it bounds - which it does only
 * for the formats that store that text verbatim.
 *
 * A container does not. A 50 KB `.xlsx` of 20,000 rows replays as the full
 * 500,000 character cap, some 125k real tokens, while its own bytes would charge
 * 20k - an under-charge of most of the budget from one file the attachment limit
 * accepts without comment.
 *
 * So a container is sized from its extracted text wherever that text is in hand.
 * The caller holds it for the current turn's containers and for as many stored
 * ones as its extraction budget allows, since this same request extracts them
 * anyway, only later. Charging an 8 KB workbook the cap instead made no cut fit
 * and collapsed the window to the newest pair: 6.5k tokens sent out of a 120k
 * budget, 38 of 40 messages dropped, over a file that really cost 2k.
 *
 * The cap remains for a container too large to extract on this path, and is
 * charged in full: it is the honest bound on what that file could replay as, and
 * a message carrying one is meant to leave no fitting cut rather than to be kept
 * and resent above the budget. Extracted text is not persisted beside an
 * attachment the way a PDF's pages are; doing so is the durable fix and belongs
 * with the attachment storage work.
 */

/** Tokens of an extraction as replay sends it: capped, with its notice line. */
const estimateExtractedTextTokens = (
  extractedText: string,
): number =>
  extractedText.length <= ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS
    ? estimateTextTokens(extractedText)
    : estimateTextTokens(extractedText.slice(0, ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS))
      + ATTACHMENT_TRUNCATION_NOTICE_TOKENS;

const estimateFileTokens = (
  part: FileContentPart,
  extractedText: string | undefined,
): number => {
  if (extractedText !== undefined) {
    return estimateExtractedTextTokens(extractedText);
  }

  if (isContainerExtractableAttachment(part)) {
    // A container cannot be read from here: sizing is synchronous and inflating
    // a ZIP is not, so this one is a cap rather than a measurement of anything -
    // charged in full, per the invariant above.
    return estimateCharacterTokens(ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS);
  }

  if (isTextFileAttachment(part)) {
    // A text attachment decodes synchronously, so the text it replays as really
    // is available here: counting it beats charging its byte count against the
    // cap, which over-charged a multi-byte file by its UTF-8 width and never
    // noticed a file that decodes shorter than it stores.
    try {
      return estimateExtractedTextTokens(decodeUtf8File(part));
    } catch (error) {
      // Reported rather than swallowed: this is the one sizing path that falls
      // back to a bound without the caller knowing, and a file that cannot be
      // decoded here cannot be replayed later either.
      log({
        domain: "chat",
        action: "attachment_sizing_decode_failed",
        vendor: "openai",
        mediaType: part.mediaType,
        sizeBytes: estimateBase64ByteLength(part.base64Data),
        error: error instanceof Error ? error.message : String(error),
      });

      return estimateCharacterTokens(Math.min(
        estimateBase64ByteLength(part.base64Data),
        ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS,
      ));
    }
  }

  // An opaque attachment replays as its own base64, which is exact in length.
  return estimateBase64Tokens(part.base64Data);
};

/**
 * Extracted text already in hand for an attachment part, keyed by the part
 * itself - for the current turn's attachments and for the stored ones this turn
 * could still replay. Sizing and sending then agree by construction, since this
 * module sizes the very string the caller is about to send, dense characters and
 * all.
 */
export type ChatAttachmentExtractedText = ReadonlyMap<ContentPart, string>;

const estimateContentPartTokens = (
  part: ContentPart,
  extractedText: ChatAttachmentExtractedText | undefined,
): number => {
  switch (part.type) {
    case "text":
      return ITEM_ENVELOPE_TOKENS + estimateTextTokens(part.text);
    case "tool_call":
      // Replay renders the status lines too, so they are charged.
      return ITEM_ENVELOPE_TOKENS
        + estimateTextTokens(part.name)
        + estimateTextTokens(part.status)
        + estimateTextTokens(part.providerStatus ?? "")
        + estimateTextTokens(part.input ?? "")
        + estimateTextTokens(part.output ?? "");
    case "reasoning_summary":
      return ITEM_ENVELOPE_TOKENS + estimateTextTokens(part.summary);
    case "image":
      return ITEM_ENVELOPE_TOKENS + IMAGE_TOKENS;
    case "file":
      return ITEM_ENVELOPE_TOKENS + estimateFileTokens(part, extractedText?.get(part));
    case "pdf":
      return part.pages.reduce(
        (total, page) => total
          + ITEM_ENVELOPE_TOKENS
          + PDF_PAGE_PROMPT_HEADER_TOKENS
          + estimateTextTokens(page.text)
          + PDF_PAGE_IMAGE_TOKENS,
        0,
      );
  }
};

/**
 * Tokens of one message's content, every part charged in full. Nothing is capped
 * per message: a message whose attachments exceed the budget has to read as
 * exceeding it, so the window cuts past it instead of keeping it and sending
 * more than the model will accept.
 */
export const estimateContentPartsTokens = (
  content: ReadonlyArray<ContentPart>,
  extractedText?: ChatAttachmentExtractedText,
): number =>
  content.reduce(
    (total, part) => total + estimateContentPartTokens(part, extractedText),
    0,
  );

/**
 * An encrypted reasoning or compaction payload is billed by the context it
 * stands for, which is unknowable until the turn is measured. Its own length is
 * proportional to that context, so it is charged rather than ignored: sizing a
 * compacted session at zero is what left the compaction path unbounded.
 */
const estimateReplayItemTokens = (
  item: StoredOpenAIReplayItem,
): number => {
  switch (item.type) {
    case "message":
      return ITEM_ENVELOPE_TOKENS + estimateTextTokens(JSON.stringify(item.content));
    case "function_call":
      return ITEM_ENVELOPE_TOKENS
        + estimateTextTokens(item.name)
        + estimateTextTokens(item.arguments)
        + estimateTextTokens(item.call_id)
        + estimateTextTokens(item.status ?? "");
    case "function_call_output":
      return ITEM_ENVELOPE_TOKENS
        + estimateTextTokens(JSON.stringify(item.output))
        + estimateTextTokens(item.call_id)
        + estimateTextTokens(item.status ?? "");
    case "reasoning":
    case "compaction":
      // An encrypted payload is base64, which tokenizes far denser than text.
      return ITEM_ENVELOPE_TOKENS + estimateBase64Tokens(item.encrypted_content);
  }
};

/**
 * Sizes exactly what replay sends for one stored message. An assistant turn
 * replays from `openaiItems` alone, so its transcript `content` is a second
 * rendering of the same answer and must not be added to it; an assistant turn
 * with no stored items replays nothing at all.
 */
const estimateMessageTokens = (
  message: ServerChatMessage,
  extractedText: ChatAttachmentExtractedText | undefined,
): number => {
  if (message.role === "assistant") {
    return (message.openaiItems ?? []).reduce(
      (total, item) => total + estimateReplayItemTokens(item),
      0,
    );
  }

  return estimateContentPartsTokens(message.content, extractedText);
};

const sumTokens = (
  values: ReadonlyArray<number>,
): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Spends `segmentTokens` across the messages of one segment, in proportion to
 * their estimates and landing exactly on the segment total.
 *
 * A segment whose estimates are all zero splits evenly instead of charging the
 * whole measurement to one message.
 */
const splitSegmentTokens = (
  estimates: ReadonlyArray<number>,
  segmentTokens: number,
): ReadonlyArray<number> => {
  const estimateTotal = sumTokens(estimates);
  const weights: Array<number> = [];
  let coveredShare = 0;
  let spentTokens = 0;
  for (const [offset, estimate] of estimates.entries()) {
    coveredShare += estimateTotal === 0
      ? 1 / estimates.length
      : estimate / estimateTotal;
    const spendTo = offset === estimates.length - 1
      ? segmentTokens
      : Math.min(segmentTokens, Math.round(segmentTokens * coveredShare));
    weights.push(spendTo - spentTokens);
    spentTokens = spendTo;
  }

  return weights;
};

/**
 * Token weight of every message.
 *
 * A measurement on the assistant message at `index` covers the messages from
 * `index - replayedMessages` through `index` itself - the stored messages its
 * call replayed, plus that call's own output, which the next turn replays and
 * the call's own input could not contain. The reserve the measurement also
 * carries is removed here and added back once when the sent input is computed,
 * so it is counted exactly once.
 *
 * The reserve therefore cancels out of the budget comparison, but not out of the
 * acceptance test below, where it sets the price of starting to measure a
 * session at all. Write `R` for the reserve constant and `O` for the real
 * per-call overhead the provider counted. A measurement whose covered range was
 * already sized by an earlier measurement subtracts a sum that carries that
 * range's real history less one `R - O`, so its segment reduces to this turn's
 * own new content and is accepted however small the turn is: a chain of
 * measurements, once started, sustains itself. The first measurement of a chain
 * has nothing to cancel against and reduces to `(R - O) + newContent`, so a
 * session whose first turn brings less new content than `R - O` is charged its
 * estimate - and estimates read high by design, so their excess accumulates in
 * the sum each later turn has to clear and the session rarely recovers. The
 * reserve is therefore set just above the measured overhead rather than
 * comfortably above it: what it buys is the first turn's admission.
 *
 * The measured segment is `inputTokens + outputTokens - reserve` minus whatever
 * an earlier measurement already assigned inside the same range, which makes
 * the suffix total from `index - replayedMessages` exactly equal to that call's
 * real measured input. Nothing is inferred about messages the measurement did
 * not cover: those keep their estimate, so a call that replayed a cut history
 * sizes only the part it sent.
 *
 * A segment left with nothing to spend means the measurement no longer exceeds
 * what its range already carries - another tokenizer, or a post-compaction
 * input. Its newly covered messages then keep their own estimates rather than a
 * zero weight, so no turn is ever sized at nothing.
 */
const buildMessageTokenWeights = (
  messages: ReadonlyArray<ServerChatMessage>,
  extractedText: ChatAttachmentExtractedText | undefined,
): ReadonlyArray<number> => {
  const weights: Array<number> = [];
  let pendingEstimates: Array<number> = [];
  for (const [index, message] of messages.entries()) {
    pendingEstimates.push(estimateMessageTokens(message, extractedText));
    const measurement = message.replayMeasurement;
    if (measurement === undefined) {
      continue;
    }

    const coveredStart = Math.max(0, index - measurement.replayedMessages);
    const uncoveredCount = Math.max(0, coveredStart - weights.length);
    weights.push(...pendingEstimates.slice(0, uncoveredCount));
    const coveredEstimates = pendingEstimates.slice(uncoveredCount);
    const segmentTokens = measurement.inputTokens
      + measurement.outputTokens
      - CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS
      - sumTokens(weights.slice(coveredStart));
    weights.push(...(segmentTokens > 0
      ? splitSegmentTokens(coveredEstimates, segmentTokens)
      : coveredEstimates));
    pendingEstimates = [];
  }

  return [...weights, ...pendingEstimates];
};

/**
 * Cumulative token size of the stored history, one entry per message boundary,
 * so `prefixTokens[i]` is the history ahead of message `i` and the last entry
 * is `totalTokens`. Weights are never negative, so the series never decreases
 * and the sent input is non-increasing in the replay start.
 */
export const measureChatHistory = (
  messages: ReadonlyArray<ServerChatMessage>,
  extractedText?: ChatAttachmentExtractedText,
): ChatHistorySizing => {
  const prefixTokens: Array<number> = [0];
  let totalTokens = 0;
  for (const weight of buildMessageTokenWeights(messages, extractedText)) {
    totalTokens += weight;
    prefixTokens.push(totalTokens);
  }

  return { prefixTokens, totalTokens };
};

const requirePrefixTokens = (
  sizing: ChatHistorySizing,
  messageIndex: number,
): number => {
  const tokens = sizing.prefixTokens.at(messageIndex);
  if (tokens === undefined) {
    throw new Error(
      `Chat history sizing has no prefix for message index ${String(messageIndex)}: `
      + `measured ${String(sizing.prefixTokens.length)} boundaries`,
    );
  }

  return tokens;
};

/**
 * Everything one call would send with the replay starting at `startIndex`: the
 * fixed per-call reserve, the current user turn, and the replayed history. This
 * is the only quantity the budget is ever compared against.
 */
export const computeSentInputTokens = (
  sizing: ChatHistorySizing,
  turnInputTokens: number,
  startIndex: number,
): number =>
  CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS
  + turnInputTokens
  + (sizing.totalTokens - requirePrefixTokens(sizing, startIndex));

/**
 * First message index to replay so the sent input fits the budget.
 *
 * The replay starts at a user turn: a kept assistant turn whose prompt was
 * dropped reads as a reply to nothing.
 *
 * Boundary motion is deliberately NOT monotone. An earlier design clamped this
 * start to the furthest boundary a previous call had used, to keep the
 * prompt-cache prefix still when estimates are replaced by measurements. It
 * cannot coexist with attachment bounds that are revised later: a floor derived
 * from a bound that was 100x too high froze a healthy session at 2 of 40
 * messages for good, and every attempt to exempt such bounds either could not
 * see them - sizing has no way to tell an extracted container from an unreadable
 * one - or turned the clamp off often enough to let the boundary oscillate
 * (measured `0, 6, 0, 12, 0, 18`). What guards against that oscillation is the
 * append-only weight rule: a weight is fixed when first assigned, so identical
 * history yields an identical boundary and a message's size never changes under
 * the window. What remains is a boundary that may step back once as each
 * measurement replaces an estimate, converging forward from there.
 *
 * Stepping back is safe by construction: weights are never negative, so the sent
 * input is non-increasing in the start index and the budget is re-checked here,
 * which means an earlier start is only ever chosen when the larger history
 * genuinely fits.
 */
const selectChatHistoryWindowStart = (
  messages: ReadonlyArray<ServerChatMessage>,
  sizing: ChatHistorySizing,
  turnInputTokens: number,
): number => {
  const fittingIndex = sizing.prefixTokens.findIndex(
    (_, startIndex) =>
      computeSentInputTokens(sizing, turnInputTokens, startIndex)
      <= CHAT_SENT_INPUT_BUDGET_TOKENS,
  );
  // `-1` means the reserve and the current turn alone exceed the budget, so no
  // amount of trimming fits and the whole stored history is a candidate to go.
  const cutIndex = fittingIndex === -1 ? messages.length : fittingIndex;
  const userTurnIndex = messages.findIndex(
    (message, index) => index >= cutIndex && message.role === "user",
  );
  if (userTurnIndex !== -1) {
    return userTurnIndex;
  }

  // No user turn at or after the cut. The newest user turn and the assistant
  // turn answering it are kept anyway: the API already accepted that pair on
  // the previous call, while replaying nothing would erase the session. A
  // history with no user turn at all cannot start at one.
  const newestUserTurnIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );

  return newestUserTurnIndex === -1 ? messages.length : newestUserTurnIndex;
};

/**
 * Where to start replaying one session's stored history.
 *
 * A stored compaction item is preferred, since its encrypted summary already
 * carries every turn ahead of it. It is accepted only while the history from it
 * onward still fits the budget: a session that compacted once and then kept
 * growing is otherwise bounded by nothing but the provider continuing to honour
 * `context_management`. When it no longer fits, the item is stale and the window
 * applies instead.
 *
 * `extractedText` sizes attachments from the text the caller has already
 * extracted for them - the current turn's and the stored ones still in reach -
 * so a container is charged what it really replays rather than its cap.
 *
 * Deterministic: identical stored history and identical turn input yield an
 * identical plan, which is what keeps the prompt-cache prefix still between
 * turns that changed nothing. Not pure - sizing reports an attachment it could
 * not decode - but nothing it reports affects what it returns.
 */
export const planChatHistoryReplay = (
  messages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
  extractedText?: ChatAttachmentExtractedText,
): ChatHistoryReplayPlan => {
  const sizing = measureChatHistory(messages, extractedText);
  const turnInputTokens = estimateContentPartsTokens(turnInput, extractedText);
  const unboundedSentInputTokens = computeSentInputTokens(sizing, turnInputTokens, 0);
  const compactionBoundary = findLatestChatCompactionBoundary(messages);

  if (compactionBoundary !== null) {
    const sentInputTokens = computeSentInputTokens(
      sizing,
      turnInputTokens,
      compactionBoundary.messageIndex,
    );
    if (sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS) {
      return {
        startIndex: compactionBoundary.messageIndex,
        compactionItemIndex: compactionBoundary.itemIndex,
        boundary: "compaction",
        droppedMessages: compactionBoundary.messageIndex,
        unboundedSentInputTokens,
        sentInputTokens,
      };
    }
  }

  const startIndex = selectChatHistoryWindowStart(messages, sizing, turnInputTokens);

  return {
    startIndex,
    compactionItemIndex: null,
    boundary: compactionBoundary !== null
      ? "stale_compaction"
      : (startIndex === 0 ? "none" : "window"),
    droppedMessages: startIndex,
    unboundedSentInputTokens,
    sentInputTokens: computeSentInputTokens(sizing, turnInputTokens, startIndex),
  };
};
