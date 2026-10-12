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
 * assistant turn, `content` for a user turn, never both. A document is not in
 * either: it is a file of the session, so what it costs an input is the one line
 * that names it.
 *
 * A measurement is used whichever of the routed models produced it, but only
 * while it still leaves tokens for the messages in its range that no earlier
 * measurement had sized. A compacted call reports its small post-compaction
 * input, so a later measurement over a superset input can legitimately come in
 * below its predecessor; sizing those messages from such a measurement would
 * weight a whole turn at nothing, so they keep their estimates instead. A
 * weight derived from a measurement is never rewritten; a weight derived from an
 * estimate is superseded by any measurement whose range covers it, so one call
 * re-sizes everything it replayed at once rather than only the messages no
 * earlier call had reached. No weight is therefore revised by more than one
 * measurement - estimate to measurement and no further - and identical history
 * always yields the identical replay boundary.
 *
 * That rule is not what makes a cross-model measurement safe, since a lower
 * measurement is adopted as it stands whenever it is still positive. What
 * makes it safe is that `CHAT_MODEL_ID` and `CHAT_FALLBACK_MODEL_ID`, which
 * `modelRouting.ts` can switch between mid-session, are of one family and count
 * with the same `o200k` tokenizer, so no model id has to be persisted beside a
 * measurement. A model on another tokenizer family would need one.
 *
 * The replay boundary is NOT monotone, and three attempts to make it so each
 * produced a P1 - permanent truncation of healthy sessions, then oscillation -
 * so do not reintroduce a floor here. What guards against attempt 2's thrash is
 * the weight rule above, and it is now the only thing that does: a
 * measurement-derived weight is immutable, so no weight is revised by more than
 * one measurement - estimate to measurement and no further. That bounds
 * measurement-driven backwards motion at one step per message, converging
 * forward. Stepping back is safe because weights are never negative - the sent
 * input is non-increasing in the start index - and the budget is re-checked, so
 * an earlier start is only ever taken when the larger history genuinely fits.
 * The reasoning is kept in full at `selectChatHistoryWindowStart`.
 *
 *
 * The invariant that governs every number below: **sizing may never claim a
 * message fits when its real content could exceed the budget.**
 *
 * So nothing here is scaled down to keep a message replayable. A quantity this
 * module can only bound - a native image, a rendered PDF page - is charged at
 * that bound in full, and a quantity it can count is counted. The consequence is
 * accepted deliberately: a message whose attachments are larger than the budget
 * leaves no cut that reaches through it, so the window cuts past it and the
 * history before it is lost.
 *
 * Ceilinging such a message at a share of the budget was measured and is worse:
 * sizing then reports that it fits. A 50-page PDF is some 81,000 tokens of
 * pages, so two of them in one window send more than the model accepts, the call
 * returns `context_length_exceeded`, an errored turn stores no measurement, and
 * sizing is deterministic - so the next turn computes the same plan and fails
 * the same way. Losing history is recoverable by asking again; a session that
 * cannot answer at all is not.
 */
import {
  CHAT_SENT_INPUT_BUDGET_TOKENS,
  CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS,
} from "@/lib/chatModels";
import { buildChatFilePromptText } from "@/server/chat/openai/responses/chatFilePrompt";
import {
  findLatestChatCompactionBoundary,
  type ServerChatMessage,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import type { ContentPart } from "@/server/chat/types";

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
 * 1.3 to 1.5 for dense ones. An encrypted reasoning or compaction payload is
 * base64, so it is charged at this rate rather than at the text rate.
 */
const BASE64_CHARS_PER_TOKEN = 1;

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
 * One `view_file` result the input rebuilds from its stored reference.
 *
 * An image is the `IMAGE_TOKENS` bound above. A PDF page is sent as a one-page
 * PDF, which the provider turns into that page's image plus its extracted text,
 * so it is charged that same `IMAGE_TOKENS` bound, rather than
 * `PDF_PAGE_IMAGE_TOKENS`, plus 2,000 tokens of text, which is around 2,800
 * characters at this module's own ratio.
 *
 * The one constant here that is not an upper bound, and deliberately: a dense
 * page of 5,000 to 6,000 extracted characters runs nearer 5,500 real tokens, so
 * such a page under-charges by about 1,500. CHAT_FILE_VIEW_REPLAYS_PER_TURN
 * holds this to four results a turn, so the whole error is at most around 6,000
 * tokens of a 120,000 token budget, and raising it would charge the ordinary
 * page - which is most of them - for the dense one. Re-tune it only alongside
 * that bound.
 *
 * Charged whether or not the part is really rebuilt for this input, per the
 * invariant above: a reference that could not be read sends a short note
 * instead, and over-charging that is the safe direction.
 */
const CHAT_FILE_VIEW_PDF_PAGE_TOKENS = 4_000;

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

const estimateBase64Tokens = (
  base64Data: string,
): number =>
  Math.ceil(base64Data.length / BASE64_CHARS_PER_TOKEN);

const estimateContentPartTokens = (
  part: ContentPart,
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
      // The line itself, because that line is the whole part: a document's
      // bytes are never in an input, and what the model spends on reading it
      // is the `bash` call it makes and the output that call returns, both of
      // them its own later items.
      return ITEM_ENVELOPE_TOKENS + estimateTextTokens(buildChatFilePromptText(part));
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
): number =>
  content.reduce(
    (total, part) => total + estimateContentPartTokens(part),
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
        + estimateTextTokens(item.status ?? "")
        + (item.chatFileView === undefined
          ? 0
          : (item.chatFileView.page === null ? IMAGE_TOKENS : CHAT_FILE_VIEW_PDF_PAGE_TOKENS));
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
): number => {
  if (message.role === "assistant") {
    return (message.openaiItems ?? []).reduce(
      (total, item) => total + estimateReplayItemTokens(item),
      0,
    );
  }

  return estimateContentPartsTokens(message.content);
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
 * One message's weight and whether a measurement produced it. The provenance
 * exists only while the weights are being built - it is what a measurement
 * consults to decide which weights inside its range it may supersede - and
 * nothing persists it: the same stored history re-derives it from scratch.
 */
type MessageTokenWeight = Readonly<{
  tokens: number;
  fromMeasurement: boolean;
}>;

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
 * Inside its own range the measurement is the truth, so it supersedes every
 * weight there that came from an estimate and keeps every weight that came from
 * an earlier measurement: only the measured ones are subtracted, and the
 * remainder is re-split across all the rest it covers. The suffix total from
 * `index - replayedMessages` is then exactly that call's real measured input
 * however much of its range an earlier call had already sized, and no weight is
 * revised by more than one measurement - estimate to measurement, never
 * measurement to measurement - which is what holds the replay boundary steady
 * with no clamp on it. Nothing is inferred about messages the measurement did
 * not cover: those keep their estimate, so a call that replayed a cut history
 * sizes only the part it sent.
 *
 * Because an estimate inside the range is replaced rather than subtracted, an
 * estimate reading high cannot price a measurement out: a session starts
 * measuring itself as soon as one call's own `input + output` exceeds the
 * reserve, whatever shape its turns take.
 *
 * A segment left with nothing to spend means the measurement does not exceed
 * what the measured part of its range already carries - another tokenizer, or a
 * post-compaction input. Its estimate-derived messages then keep their own
 * estimates rather than a zero weight, so no turn is ever sized at nothing, and
 * a later measurement may still supersede them.
 */
const buildMessageTokenWeights = (
  messages: ReadonlyArray<ServerChatMessage>,
): ReadonlyArray<number> => {
  const weights: Array<MessageTokenWeight> = [];
  for (const [index, message] of messages.entries()) {
    weights.push({
      tokens: estimateMessageTokens(message),
      fromMeasurement: false,
    });
    const measurement = message.replayMeasurement;
    if (measurement === undefined) {
      continue;
    }

    const coveredStart = Math.max(0, index - measurement.replayedMessages);
    const covered = weights.slice(coveredStart);
    const coveredEstimates: Array<number> = [];
    let measuredTokens = 0;
    for (const weight of covered) {
      if (weight.fromMeasurement) {
        measuredTokens += weight.tokens;
      } else {
        coveredEstimates.push(weight.tokens);
      }
    }

    const segmentTokens = measurement.inputTokens
      + measurement.outputTokens
      - CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS
      - measuredTokens;
    // `covered` always holds at least one estimate - this message's own, pushed
    // above, since no measurement's range reaches past its own index - so an
    // all-measured range is not a case to guard. The test is a validity check on
    // the arithmetic and not only on the sign: `isMeasurementCount` keeps `NaN`
    // out of a stored measurement but admits `1e308`, and `1e308 + 1e308` is
    // `Infinity`, whose split spreads `Infinity - Infinity` as `NaN` over every
    // weight in the range. `selectChatHistoryWindowStart` and
    // `computeSentInputTokens` then read an unsizeable session and collapse it to
    // its newest user turn on its every later turn, so a non-finite segment is
    // rejected and its range keeps its estimates, exactly as a segment with
    // nothing to spend does.
    if (!(Number.isFinite(segmentTokens) && segmentTokens > 0)) {
      continue;
    }

    const segmentWeights = splitSegmentTokens(coveredEstimates, segmentTokens);
    let spentWeights = 0;
    for (const [offset, weight] of covered.entries()) {
      if (weight.fromMeasurement) {
        continue;
      }
      weights[coveredStart + offset] = {
        tokens: segmentWeights[spentWeights],
        fromMeasurement: true,
      };
      spentWeights += 1;
    }
  }

  return weights.map((weight) => weight.tokens);
};

/**
 * Cumulative token size of the stored history, one entry per message boundary,
 * so `prefixTokens[i]` is the history ahead of message `i` and the last entry
 * is `totalTokens`. Weights are never negative, so the series never decreases
 * and the sent input is non-increasing in the replay start.
 */
export const measureChatHistory = (
  messages: ReadonlyArray<ServerChatMessage>,
): ChatHistorySizing => {
  const prefixTokens: Array<number> = [0];
  let totalTokens = 0;
  for (const weight of buildMessageTokenWeights(messages)) {
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
 * cannot coexist with an estimate a later measurement revises: a floor derived
 * from an estimate that was 100x too high froze a healthy session at 2 of 40
 * messages for good, and every attempt to exempt such estimates either could
 * not see them or turned the clamp off often enough to let the boundary
 * oscillate (measured `0, 6, 0, 12, 0, 18`). What guards against that oscillation is the
 * weight rule: a measurement-derived weight is immutable, so identical history
 * yields an identical boundary and no weight is revised by more than one
 * measurement under the window. What remains is a boundary that may step back
 * once as each measurement supersedes the estimates in its range, converging
 * forward from there.
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
 * `trailingSystemText` is a system item the input appends after the user turn,
 * such as the file manifest. It is not part of the fixed reserve, because it is
 * neither fixed nor the same between sessions, so it is charged here with the
 * turn it is sent on.
 *
 * Pure and deterministic: identical stored history and identical turn input
 * yield an identical plan, which is what keeps the prompt-cache prefix still
 * between turns that changed nothing.
 */
export const planChatHistoryReplay = (
  messages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
  trailingSystemText?: string,
): ChatHistoryReplayPlan => {
  const sizing = measureChatHistory(messages);
  const turnInputTokens = estimateContentPartsTokens(turnInput)
    + (trailingSystemText === undefined
      ? 0
      : ITEM_ENVELOPE_TOKENS + estimateTextTokens(trailingSystemText));
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
