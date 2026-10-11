export const CHAT_VENDOR = "openai" as const;
export const CHAT_MODEL_ID = "gpt-6.1-sol" as const;
export const CHAT_MODEL_REASONING_EFFORT = "medium" as const;
export const CHAT_FALLBACK_MODEL_ID = "gpt-6-luna" as const;
export const CHAT_FALLBACK_MODEL_REASONING_EFFORT = "max" as const;
export const CHAT_MODEL_REASONING_SUMMARY = "auto" as const;
/**
 * Input-token threshold handed to OpenAI server-side compaction. A call whose
 * input exceeds it is answered with a compaction item standing for the context
 * it absorbed, which later calls replay instead of the turns themselves.
 */
export const CHAT_COMPACT_THRESHOLD_TOKENS = 80_000;
/**
 * Ceiling on the input one model call may send: the system instructions, the
 * tool schemas, the replayed history, the current user turn and the clock item
 * together.
 *
 * It must stay strictly above `CHAT_COMPACT_THRESHOLD_TOKENS` so a long session
 * is summarized by compaction before the window starts dropping its oldest
 * turns outright. The window is the floor under that: it holds even when no
 * compaction item exists, or when the one that exists no longer covers enough.
 */
export const CHAT_SENT_INPUT_BUDGET_TOKENS = 120_000;
/**
 * Fixed reserve for everything one call sends besides the replayed history and
 * the current user turn: the system instructions, the tool schemas, the trailing
 * clock item and the request envelope.
 *
 * Deliberately a constant rather than a measured quantity - a reserve inferred
 * from a response would need a request to compute, and the window has to be
 * decided before the first call of a turn. `history.test.ts` fails if the real
 * instructions, tool schemas and clock outgrow it.
 *
 * Counter-intuitively, over-estimating is not the safe direction for this one
 * constant. It is safe for the budget comparison, where it cancels, and fatal
 * for the attribution: the reserve is subtracted from every stored measurement
 * before that measurement is attributed, so the gap between this constant and
 * the real per-call overhead `O` is what a session has to pay to start measuring
 * itself at all. The gap is charged once, to the first measurement of a chain -
 * every later measurement cancels against its predecessor and is accepted
 * however small its turn is - but a session that fails to pay it is charged
 * estimates, which read high by design, and their accumulating excess keeps
 * later measurements out too. At 8,000 against a real overhead of 1,522 no
 * measurement was ever usable: a simulated 120-turn session stayed on estimates
 * end to end and started dropping turns at around 83k real tokens, barely above
 * the compaction threshold this budget deliberately sits 40k above.
 *
 * Measured with `o200k_base` on the real prompt: instructions 1,045 + tool
 * schemas 989 + clock 44 = 2,078 tokens. The schema figure is the five catalog
 * tools at their measured 805 plus 184 for the rendered `bash` tool; the
 * instructions grew from 673 when the `## Files and the shell` section was
 * added for it, re-measured whole rather than estimated.
 *
 * 2,600 therefore leaves 522 tokens of headroom, and that number is the one to
 * read before adding anything here: the prompt and the tool catalog have to fit
 * inside it. It is also exactly what a session's first turn is priced at - the
 * reserve minus the real overhead - so a question answered with a tool call and
 * reasoning clears it comfortably while a session opened with "hi" does not and
 * stays on estimates, which is the one shape this value gives up on. Raising
 * the reserve to buy room is the mistake this whole comment exists to prevent:
 * every token added above the real overhead is added to that admission price.
 *
 * The simulation behind the choice was run when the overhead was 1,522 and the
 * price was 1,078: a first turn of 1,079 new tokens measured 200 of 200 later
 * turns, one of 1,077 measured none. The mechanism is unchanged and the price
 * is now lower, so measurement starts more easily than it did then, not less.
 */
export const CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS = 2_600;
export const CHAT_MODEL_LABEL = "GPT-6.1 Sol" as const;
export const CHAT_PROVIDER_LABEL = "OpenAI" as const;
export const CHAT_MODEL_REASONING_LABEL = `${CHAT_MODEL_REASONING_EFFORT.slice(0, 1).toUpperCase()}${CHAT_MODEL_REASONING_EFFORT.slice(1)}` as const;
export const CHAT_MODEL_BADGE_LABEL = `${CHAT_MODEL_LABEL} · ${CHAT_MODEL_REASONING_LABEL}` as const;

export type ChatEffectiveModelId =
  | typeof CHAT_MODEL_ID
  | typeof CHAT_FALLBACK_MODEL_ID;

export type ChatEffectiveReasoningEffort =
  | typeof CHAT_MODEL_REASONING_EFFORT
  | typeof CHAT_FALLBACK_MODEL_REASONING_EFFORT;

export type ChatModelDef = Readonly<{
  id: typeof CHAT_MODEL_ID;
  label: typeof CHAT_MODEL_LABEL;
  vendor: typeof CHAT_VENDOR;
}>;

export const CHAT_MODEL: ChatModelDef = {
  id: CHAT_MODEL_ID,
  label: CHAT_MODEL_LABEL,
  vendor: CHAT_VENDOR,
};
