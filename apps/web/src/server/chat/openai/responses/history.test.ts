import assert from "node:assert/strict";
import test from "node:test";
import { getEncoding } from "js-tiktoken";
import { ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS } from "@/lib/chatAttachments";
import {
  CHAT_SENT_INPUT_BUDGET_TOKENS,
  CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS,
} from "@/lib/chatModels";
import {
  computeSentInputTokens,
  estimateContentPartsTokens,
  measureChatHistory,
  planChatHistoryReplay,
} from "@/server/chat/openai/responses/history";
import {
  parseChatHistoryMeasurement,
  type ChatHistoryMeasurement,
  type ServerChatMessage,
  type StoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import { buildPdfPagePromptText } from "@/server/chat/openai/responses/input";
import { OPENAI_CHAT_TOOLS } from "@/server/chat/openai/tooling/tools";
import { buildSystemInstructions, formatDatetime } from "@/server/chat/shared";
import type { ContentPart } from "@/server/chat/types";

const COMPACTION_ITEM: StoredOpenAIReplayItem = {
  type: "compaction",
  id: "compaction-1",
  encrypted_content: "opaque-summary",
};

const TURN_INPUT: ReadonlyArray<ContentPart> = [{ type: "text", text: "Continue" }];

/**
 * What the provider would really count, at the four characters per token that
 * English text runs to. The module's own estimate reads higher on purpose, so a
 * simulation that drives measurements from this is the only way to see whether
 * the bound holds against real usage rather than against its own estimate.
 */
const REAL_CHARACTERS_PER_TOKEN = 4;

/**
 * Characters per token of this product's densest realistic content, measured
 * with `o200k_base`: an amounts-only column runs 1.50, opaque ids 1.46 and CJK
 * prose 1.44. A simulation at this rate is the only one that can see the sizing
 * under-charge a CSV-shaped session, which is how a window computes 120,000 and
 * sends 156,000.
 */
const DENSE_CHARACTERS_PER_TOKEN = 1.6;

/**
 * The real tokenizer, for grounding assertions that would otherwise check the
 * implementation against its own arithmetic. `js-tiktoken` is a dev dependency
 * only: the measurements that kept it out of the request path are recorded in
 * `02c`, and loading the ranks costs about 220 ms and 190 MB, so it is loaded
 * once and lazily here.
 */
let cachedEncoder: ReturnType<typeof getEncoding> | null = null;
const realTokenCount = (text: string): number => {
  cachedEncoder ??= getEncoding("o200k_base");

  return cachedEncoder.encode(text).length;
};

const realTextTokens = (text: string): number =>
  Math.ceil(text.length / REAL_CHARACTERS_PER_TOKEN);

const realMessageTokens = (message: ServerChatMessage): number =>
  message.content.reduce(
    (total, part) => total + (part.type === "text" ? realTextTokens(part.text) : 0),
    0,
  );

const createUserMessage = (text: string): ServerChatMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const createAssistantMessage = (
  text: string,
  replayMeasurement: ChatHistoryMeasurement | undefined,
  leadingItems: ReadonlyArray<StoredOpenAIReplayItem>,
): ServerChatMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  openaiItems: [
    ...leadingItems,
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ],
  ...(replayMeasurement === undefined ? {} : { replayMeasurement }),
});

const TURN_TEXT_CHARACTERS = 6_000;

/**
 * The real per-call overhead, measured with `o200k_base`: instructions 673 +
 * tool schemas 805 + clock 44.
 */
const REAL_OVERHEAD_TOKENS = 1_522;

/**
 * What the module charges for one rendered PDF page image. Mirrored here so a
 * page's text can be compared against the tokenizer without the image, which no
 * tokenizer can price.
 */
const PDF_PAGE_IMAGE_TOKENS_FOR_TEST = 1_500;

/** Tabular text of the shape this product imports and replays. */
const denseText = (label: string, rows: number): string =>
  `${label}\ndate,amount,category,currency\n${Array.from(
    { length: rows },
    (_, index) => `2026-08-${String((index % 28) + 1).padStart(2, "0")},-${String(1_000 + index)}.${String(index % 100).padStart(2, "0")},Groceries,EUR\n`,
  ).join("")}`;

const createDenseUnmeasuredSession = (
  turnCount: number,
): ReadonlyArray<ServerChatMessage> =>
  Array.from({ length: turnCount }).flatMap((_, turnIndex) => [
    createUserMessage(denseText(`Question ${String(turnIndex)}`, 60)),
    createAssistantMessage(denseText(`Answer ${String(turnIndex)}`, 60), undefined, []),
  ]);

/** Real `o200k` tokens of everything one call would send for this plan. */
const realSentInputTokens = (
  messages: ReadonlyArray<ServerChatMessage>,
  startIndex: number,
  turnInput: ReadonlyArray<ContentPart>,
): number =>
  REAL_OVERHEAD_TOKENS
  + messages.slice(startIndex).reduce(
    (total, message) => total + (message.role === "assistant"
      ? (message.openaiItems ?? []).reduce(
        (items, item) => items + realTokenCount(JSON.stringify(item)),
        0,
      )
      : message.content.reduce(
        (parts, part) => parts + (part.type === "text" ? realTokenCount(part.text) : 0),
        0,
      )),
    0,
  )
  + turnInput.reduce(
    (total, part) => total + (part.type === "text" ? realTokenCount(part.text) : 0),
    0,
  );

const createUnmeasuredSession = (
  turnCount: number,
  compactionTurnIndex: number | null,
): ReadonlyArray<ServerChatMessage> =>
  Array.from({ length: turnCount }).flatMap((_, turnIndex) => [
    createUserMessage(
      `Question ${String(turnIndex)} ${"q".repeat(TURN_TEXT_CHARACTERS)}`,
    ),
    createAssistantMessage(
      `Answer ${String(turnIndex)} ${"a".repeat(TURN_TEXT_CHARACTERS)}`,
      undefined,
      turnIndex === compactionTurnIndex ? [COMPACTION_ITEM] : [],
    ),
  ]);

test("the fixed per-call reserve covers the real instructions, tool schemas and clock", (): void => {
  // The reserve has to be a constant: the window is chosen before the first
  // call of a turn, so nothing measured can be waited for. This is the check
  // that keeps the constant honest as the prompt and the catalog grow, and it
  // counts the prompt with the tokenizer the models actually use rather than
  // through the module's own estimate, which is the bound for dense replayed
  // content and would demand a reserve far above the real overhead.
  const overheadTokens = realTokenCount(buildSystemInstructions())
    + realTokenCount(JSON.stringify(OPENAI_CHAT_TOOLS))
    + realTokenCount(formatDatetime("Europe/Madrid"));

  assert.ok(
    overheadTokens <= CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS,
    `The real per-call overhead is now ${String(overheadTokens)} o200k tokens, past `
    + `the ${String(CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS)} token reserve. Re-measure `
    + "the prompt with o200k and trim it, or shrink the tool catalog - do NOT raise "
    + "the reserve: every token of reserve above the real overhead is a token added to "
    + "the admission price of the first measurement of every session.",
  );
});

test("the character estimate is an upper bound on every shape this product replays", (): void => {
  // The one constant the window cannot be wrong about downwards. Each of these
  // is content this product really sends, and every ratio below 1 is a session
  // that computes one input size and sends a larger one.
  const amountsColumn = `amount\n${Array.from(
    { length: 400 },
    (_, index) => `-${String(1_000 + index)}.${String(index % 100).padStart(2, "0")}\n`,
  ).join("")}`;
  const shapes: ReadonlyArray<readonly [string, string]> = [
    ["english prose", "The monthly budget review covers every account and planned expense. ".repeat(40)],
    ["bank statement csv", `date,amount,category,currency\n${Array.from(
      { length: 300 },
      (_, index) => `2026-08-${String((index % 28) + 1).padStart(2, "0")},-${String(1_000 + index)}.00,Groceries,EUR\n`,
    ).join("")}`],
    ["amounts only column", amountsColumn],
    ["opaque ids", Array.from({ length: 300 }, (_, index) => `txn_7f3a${String(index).padStart(6, "0")}b2c9,`).join("")],
    ["cjk prose", "这个月的预算回顾涵盖了每一个账户和计划支出。".repeat(40)],
    // The blocks that set `NON_ASCII_TOKENS_PER_CHARACTER`, scanned over the BMP:
    // rare CJK, Yi syllables, CJK compatibility ideographs and the worst single
    // character all reach 3.000 tokens each, and the Private Use Area - where
    // symbol-font text extracted from a DOCX lands - averages 2.910.
    ["private use area", "\ue000\ue123\uf8ff\ue456\ue789".repeat(60)],
    ["cjk compatibility ideographs", "\uf900\uf901\ufa0e\ufa20\ufaff".repeat(60)],
    ["yi syllables", "\ua000\ua123\ua456\ua48c\ua001".repeat(60)],
    ["worst bmp character u+0801", "\u0801".repeat(300)],
    ["cjk extension a", "\u3400\u3500\u4000\u4db5\u3401".repeat(60)],
    ["hebrew prose", "סקירת התקציב החודשית מכסה כל חשבון והוצאה מתוכננת. ".repeat(30)],
    ["russian prose", "Ежемесячный обзор бюджета охватывает каждый счёт и расход. ".repeat(30)],
    ["emoji and symbols", "€1.234,56 → 💸 ✅ ₪ ¥ £ §±≠≈ ".repeat(80)],
    ["sql", "select date_trunc('month', t.occurred_at) as month, sum(t.amount_minor) from transactions t group by 1;\n".repeat(20)],
    ["json tool output", JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
      date: "2026-08-16",
      amount: -(1_000 + index),
      category: "Groceries",
    })))],
  ];

  for (const [name, text] of shapes) {
    const estimated = estimateContentPartsTokens([{ type: "text", text }]);
    const real = realTokenCount(text);
    assert.ok(
      estimated >= real,
      `${name} really costs ${String(real)} o200k tokens and is sized at `
      + `${String(estimated)}: the estimate must never read low`,
    );
  }

  // An opaque attachment replays as a base64 data URL, which reaches one token
  // per character - its decoded byte count is not the quantity being sent.
  const base64Data = Buffer.from("x".repeat(30_000)).toString("base64");
  assert.ok(
    estimateContentPartsTokens([{
      type: "file",
      fileName: "archive.bin",
      mediaType: "application/octet-stream",
      base64Data,
    }]) >= realTokenCount(base64Data),
  );
});

test("a container with no extracted text is charged its honest cap", (): void => {
  // Nobody has read this one - too large for the sizing path to extract - so its
  // size is a bound. It is charged at that bound in full, which is larger than
  // the budget, so no cut reaches through it: the window drops the message and
  // the history before it. The alternative, scaling it down to keep the message
  // replayable, makes sizing claim a fit it cannot deliver.
  const base64Data = Buffer.from("x".repeat(400_000)).toString("base64");
  const workbookTokens = estimateContentPartsTokens([{
    type: "file",
    fileName: "ledger.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64Data,
  }]);
  const docxTokens = estimateContentPartsTokens([{
    type: "file",
    fileName: "notes.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    base64Data,
  }]);

  for (const tokens of [workbookTokens, docxTokens]) {
    assert.ok(
      tokens >= ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS / 1.4,
      `An unread container is charged ${String(tokens)} tokens, under the cap on the `
      + "text it could replay as",
    );
  }
});

test("two unread containers in one message are both charged", (): void => {
  // A message can carry any number of attachments: the picker is a bare multiple
  // input with no count cap. Charging a per-message ceiling instead of both of
  // them made sizing report 114,793 for a message that really sent 796,814.
  const container = (fileName: string): ContentPart => ({
    type: "file",
    fileName,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64Data: Buffer.from("x".repeat(400_000)).toString("base64"),
  });
  const one = estimateContentPartsTokens([container("a.xlsx")]);

  const two = estimateContentPartsTokens([container("a.xlsx"), container("b.xlsx")]);

  assert.ok(
    two >= one * 2,
    `Two unread containers are charged ${String(two)} tokens, less than the `
    + `${String(one * 2)} the same two parts cost separately`,
  );
  assert.ok(two > CHAT_SENT_INPUT_BUDGET_TOKENS);
});

test("a large CSV attachment is charged what it really costs", (): void => {
  // The headline case, and the ordinary one: a bank export is this product's own
  // import format. 500,000 characters of it cost 250,021 real tokens - twice the
  // budget in one message - and were charged 60,000 while the per-message
  // ceiling stood. A ceiling reintroduced on the ASCII path alone would pass a
  // CJK-only test and fail here.
  const content = `date,amount,category,currency\n${Array.from(
    { length: 15_000 },
    (_, index) => `2026-08-${String((index % 28) + 1).padStart(2, "0")},-${String(1_000 + index)}.${String(index % 100).padStart(2, "0")},Groceries,EUR\n`,
  ).join("")}`;
  const attachment: ContentPart = {
    type: "file",
    fileName: "statement.csv",
    mediaType: "text/csv",
    base64Data: Buffer.from(content, "utf8").toString("base64"),
  };

  const sized = estimateContentPartsTokens([attachment]);

  const real = realTokenCount(content.slice(0, ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS));
  assert.ok(
    sized >= real,
    `A CSV attachment really costs ${String(real)} o200k tokens and is sized at `
    + `${String(sized)}: sizing may never claim a message fits when its real `
    + "content could exceed the budget",
  );
  assert.ok(real > CHAT_SENT_INPUT_BUDGET_TOKENS);
  assert.ok(sized > CHAT_SENT_INPUT_BUDGET_TOKENS);
});

test("a CJK text attachment is charged what it really costs", (): void => {
  // The case that retired the per-message ceiling: 500,000 CJK characters really
  // cost 386,367 tokens. Sized at a ceiling of 60,024 the window kept the
  // message, the call came back `context_length_exceeded`, an errored turn
  // stores no measurement, and the identical plan failed again on every retry.
  const sentence = "这个月的预算回顾涵盖了每一个账户和计划支出。";
  const asAttachment = (content: string): ContentPart => ({
    type: "file",
    fileName: "notes.txt",
    mediaType: "text/plain",
    base64Data: Buffer.from(content, "utf8").toString("base64"),
  });
  // Grounded on a sample, so the suite does not spend seconds tokenizing half a
  // megabyte of CJK: the rate is what matters and it is linear.
  const sample = sentence.repeat(2_000);

  const sampleSized = estimateContentPartsTokens([asAttachment(sample)]);

  const sampleReal = realTokenCount(sample);
  assert.ok(
    sampleSized >= sampleReal,
    `CJK text really costs ${String(sampleReal)} o200k tokens and is sized at `
    + `${String(sampleSized)}: sizing may never claim a message fits when its real `
    + "content could exceed the budget",
  );
  // And at the size a user really attaches, the message reads as not fitting.
  const full = estimateContentPartsTokens([asAttachment(sentence.repeat(23_810))]);
  assert.ok(full > CHAT_SENT_INPUT_BUDGET_TOKENS);
  assert.ok(
    sampleReal / sample.length * ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS
    > CHAT_SENT_INPUT_BUDGET_TOKENS,
  );
});

test("a container is charged its extracted text when the caller has extracted it", (): void => {
  // The bound above is for a container nobody has read. For the current turn, and
  // for a stored one still in reach, the caller extracts the text anyway, and
  // charging a small workbook a six-figure bound instead of the 2k it really
  // replays collapsed the whole window.
  const workbook: ContentPart = {
    type: "file",
    fileName: "ledger.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64Data: Buffer.from("x".repeat(8_000)).toString("base64"),
  };
  const extractedText = `date,amount\n${Array.from(
    { length: 40 },
    (_, index) => `2026-08-16,-${String(1_000 + index)}.00\n`,
  ).join("")}`;

  const sizedFromText = estimateContentPartsTokens(
    [workbook],
    new Map([[workbook, extractedText]]),
  );

  assert.ok(sizedFromText >= realTokenCount(extractedText));
  assert.ok(sizedFromText < estimateContentPartsTokens([workbook]) / 10);
  // Replay caps the extraction, so sizing cannot be talked far past that cap
  // either - only by the `[truncated: ...]` notice replay appends past it.
  const atCap = estimateContentPartsTokens(
    [workbook],
    new Map([[workbook, "x".repeat(ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS)]]),
  );
  const pastCap = estimateContentPartsTokens(
    [workbook],
    new Map([[workbook, "x".repeat(ATTACHMENT_MAXIMUM_EXTRACTED_TEXT_CHARACTERS * 4)]]),
  );
  assert.ok(pastCap > atCap, "the truncation notice past the cap is charged");
  assert.ok(pastCap <= atCap + 128);
});

test("a text attachment larger than the budget is cut past, not kept and oversent", (): void => {
  // A 518 KB `.txt` is 87,101 real tokens. The character bound charges it
  // 357,231, so no cut reaches through it and the window starts after it: the
  // history before it is lost, which is the accepted trade. What must not happen
  // is the opposite - sizing reporting a fit and the call failing - so the
  // reported size stays inside the budget while the message itself is dropped.
  const content = "The monthly budget review covers every account, transfer and planned expense. "
    .repeat(6_700);
  const attachment: ContentPart = {
    type: "file",
    fileName: "notes.txt",
    mediaType: "text/plain",
    base64Data: Buffer.from(content, "utf8").toString("base64"),
  };
  const turn = (index: number): ReadonlyArray<ServerChatMessage> => [
    createUserMessage(`Question ${String(index)}`),
    createAssistantMessage(`Answer ${String(index)}`, undefined, []),
  ];
  const attachmentIndex = 20;
  const messages: ReadonlyArray<ServerChatMessage> = [
    ...Array.from({ length: 10 }).flatMap((_, index) => turn(index)),
    { role: "user", content: [attachment] },
    createAssistantMessage("Answer about the file", undefined, []),
    ...Array.from({ length: 10 }).flatMap((_, index) => turn(index + 11)),
  ];

  const plan = planChatHistoryReplay(messages, TURN_INPUT);

  assert.ok(estimateContentPartsTokens([attachment]) >= realTokenCount(content));
  assert.ok(
    plan.startIndex > attachmentIndex,
    `The window kept a message sized past the budget: startIndex ${String(plan.startIndex)}`,
  );
  assert.ok(plan.sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS);
  // The turns after it still replay, so the session keeps working.
  assert.ok(messages.length - plan.startIndex >= 10);
});

test("the item envelope covers what a replayed item really costs around its text", (): void => {
  // `ITEM_ENVELOPE_TOKENS` stands for the JSON envelope, the role and type
  // markers and the rendered prefixes. An empty-argument function call is the
  // case that exposes it: the envelope is then nearly the whole cost, and the
  // `call_id`, `id` and `status` fields that replay sends were once free.
  const functionCall: StoredOpenAIReplayItem = {
    type: "function_call",
    call_id: "call_a1b2c3d4e5f6a7b8c9d0",
    name: "sql_query",
    arguments: "{}",
    status: "completed",
  };
  const output: StoredOpenAIReplayItem = {
    type: "function_call_output",
    call_id: "call_a1b2c3d4e5f6a7b8c9d0",
    output: "{}",
    status: "completed",
  };

  for (const item of [functionCall, output]) {
    const sizing = measureChatHistory([
      { role: "assistant", content: [], openaiItems: [item] },
    ]);
    const real = realTokenCount(JSON.stringify(item));
    assert.ok(
      sizing.totalTokens >= real,
      `A replayed ${item.type} really costs ${String(real)} o200k tokens and is sized `
      + `at ${String(sizing.totalTokens)}`,
    );
  }
});

test("a PDF page is charged the fixed instructions replay wraps around it", (): void => {
  // Every replayed page carries a fixed preamble - what the page is, that the
  // text and the image are two views of it - which is real sent content and was
  // once charged nothing. A page with one line on it is the case that shows it:
  // there is no margin on the page's own text to pay for the preamble out of.
  const pageText = "date,amount\n2026-08-16,-844.82\n";
  const page = { pageNumber: 1, text: pageText, jpegBase64Data: "" };
  const pdf: ContentPart = {
    type: "pdf",
    fileName: "statement.pdf",
    mediaType: "application/pdf",
    sourceSha256: "a".repeat(64),
    pages: [page],
  };

  // The page image is priced as an image, so compare only the text replay sends.
  const sizedText = estimateContentPartsTokens([pdf]) - PDF_PAGE_IMAGE_TOKENS_FOR_TEST;
  const real = realTokenCount(buildPdfPagePromptText(pdf, 1, pageText));

  assert.ok(
    sizedText >= real,
    `A replayed PDF page really costs ${String(real)} o200k tokens of text and is `
    + `sized at ${String(sizedText)}`,
  );
});

test("an unmeasured session is bounded by its estimates alone", (): void => {
  const messages = createUnmeasuredSession(40, null);

  const plan = planChatHistoryReplay(messages, TURN_INPUT);

  assert.equal(plan.boundary, "window");
  assert.equal(messages[plan.startIndex]?.role, "user");
  assert.ok(plan.unboundedSentInputTokens > CHAT_SENT_INPUT_BUDGET_TOKENS);
  assert.equal(plan.droppedMessages, plan.startIndex);
  // Nothing is dropped beyond what the budget demands: one turn more would not
  // have fit.
  const sizing = measureChatHistory(messages);
  assert.ok(
    computeSentInputTokens(
      sizing,
      estimateContentPartsTokens(TURN_INPUT),
      plan.startIndex - 2,
    ) > CHAT_SENT_INPUT_BUDGET_TOKENS,
  );
  // Grounded against the tokenizer rather than against the sizing that chose
  // this boundary: `plan.sentInputTokens <= budget` is what `startIndex` is
  // selected to satisfy, so on its own it asserts nothing.
  const realSent = realSentInputTokens(messages, plan.startIndex, TURN_INPUT);
  assert.ok(
    realSent <= CHAT_SENT_INPUT_BUDGET_TOKENS,
    `An unmeasured session really sends ${String(realSent)} o200k tokens, past the `
    + `${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
  );
});

test("an unmeasured session of tabular turns really sends less than the budget", (): void => {
  // The shape the window has to survive: CSV is this product's import format and
  // tokenizes near 1.5 characters per token, where the sizing used to read 2.5
  // and a session computed at 120,000 really sent 156,000.
  const messages = createDenseUnmeasuredSession(60);
  const turnInput: ReadonlyArray<ContentPart> = [
    { type: "text", text: denseText("Question 60", 60) },
  ];

  const plan = planChatHistoryReplay(messages, turnInput);

  assert.ok(plan.unboundedSentInputTokens > CHAT_SENT_INPUT_BUDGET_TOKENS);
  const realSent = realSentInputTokens(messages, plan.startIndex, turnInput);
  assert.ok(
    realSent <= CHAT_SENT_INPUT_BUDGET_TOKENS,
    `A tabular session really sends ${String(realSent)} o200k tokens, past the `
    + `${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
  );
  // And the bound is not won by dropping everything.
  assert.ok(plan.startIndex < messages.length - 2);
});

test("an unmeasured session of the densest content stays inside the budget turn after turn", (): void => {
  // Driven at `DENSE_CHARACTERS_PER_TOKEN` rather than through the tokenizer, so
  // the whole simulation stays cheap: what it checks is that the sizing of a
  // session nobody ever measured still bounds the real tokens sent, turn after
  // turn, as the window starts cutting.
  const realTokensOf = (text: string): number =>
    Math.ceil(text.length / DENSE_CHARACTERS_PER_TOKEN);
  let messages: ReadonlyArray<ServerChatMessage> = [];

  for (let turnIndex = 0; turnIndex < 60; turnIndex += 1) {
    const question = `Question ${String(turnIndex)} ${"q".repeat(TURN_TEXT_CHARACTERS)}`;
    const answer = `Answer ${String(turnIndex)} ${"a".repeat(TURN_TEXT_CHARACTERS)}`;
    const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: question }];
    const plan = planChatHistoryReplay(messages, turnInput);
    const realSent = REAL_OVERHEAD_TOKENS
      + messages.slice(plan.startIndex).reduce(
        (total, message) => total + message.content.reduce(
          (parts, part) => parts + (part.type === "text" ? realTokensOf(part.text) : 0),
          0,
        ),
        0,
      )
      + realTokensOf(question);

    assert.ok(
      realSent <= CHAT_SENT_INPUT_BUDGET_TOKENS,
      `Turn ${String(turnIndex)} of an unmeasured session really sent ${String(realSent)} `
      + `tokens at ${String(DENSE_CHARACTERS_PER_TOKEN)} characters per token, past the `
      + `${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
    );

    messages = [
      ...messages,
      createUserMessage(question),
      createAssistantMessage(answer, undefined, []),
    ];
  }
});

test("a measurement sizes exactly the messages its call sent, its own output included", (): void => {
  const measurement: ChatHistoryMeasurement = {
    inputTokens: 40_000,
    outputTokens: 2_000,
    // The window had already cut the first turn out of this call's input: it
    // sent the current question alone, which is the stored message ahead of the
    // answer it produced.
    replayedMessages: 1,
  };
  const messages: ReadonlyArray<ServerChatMessage> = [
    createUserMessage(`Oldest question ${"o".repeat(TURN_TEXT_CHARACTERS)}`),
    createAssistantMessage(`Oldest answer ${"o".repeat(TURN_TEXT_CHARACTERS)}`, undefined, []),
    createUserMessage(`Recent question ${"r".repeat(TURN_TEXT_CHARACTERS)}`),
    createAssistantMessage(
      `Recent answer ${"r".repeat(TURN_TEXT_CHARACTERS)}`,
      measurement,
      [],
    ),
  ];

  const sizing = measureChatHistory(messages);

  // Replaying from the first message the call sent would send exactly what that
  // call sent, reserve included, plus whatever the next turn adds. Without the
  // output of the answer at the boundary this would fall short by a whole turn.
  assert.equal(
    computeSentInputTokens(sizing, 0, 2),
    measurement.inputTokens + measurement.outputTokens,
  );
  // The messages the call did not send keep their own estimates.
  const firstMessageTokens = sizing.prefixTokens[1];
  assert.equal(firstMessageTokens, estimateContentPartsTokens(messages[0].content));
  assert.ok(firstMessageTokens > 0);
});

test("a measurement that came in below its predecessor leaves its own turns on estimates", (): void => {
  const firstMeasurement: ChatHistoryMeasurement = {
    inputTokens: 60_000,
    outputTokens: 1_000,
    replayedMessages: 1,
  };
  // Another tokenizer after a model switch, or the post-compaction input of a
  // run that compacted: a superset input measured below its predecessor.
  const laterMeasurement: ChatHistoryMeasurement = {
    inputTokens: 20_000,
    outputTokens: 1_000,
    replayedMessages: 3,
  };
  const olderTurn: ReadonlyArray<ServerChatMessage> = [
    createUserMessage(`Older question ${"o".repeat(TURN_TEXT_CHARACTERS)}`),
    createAssistantMessage(
      `Older answer ${"o".repeat(TURN_TEXT_CHARACTERS)}`,
      firstMeasurement,
      [],
    ),
  ];
  const newerQuestion = createUserMessage(`Newer question ${"n".repeat(TURN_TEXT_CHARACTERS)}`);
  const newerAnswerText = `Newer answer ${"n".repeat(TURN_TEXT_CHARACTERS)}`;

  const squeezedSizing = measureChatHistory([
    ...olderTurn,
    newerQuestion,
    createAssistantMessage(newerAnswerText, laterMeasurement, []),
  ]);
  const unmeasuredSizing = measureChatHistory([
    ...olderTurn,
    newerQuestion,
    createAssistantMessage(newerAnswerText, undefined, []),
  ]);

  // The newest turn is sized exactly as it would be with no measurement at all,
  // never at nothing, and the measurement already attributed still stands.
  assert.deepEqual(squeezedSizing.prefixTokens, unmeasuredSizing.prefixTokens);
  assert.ok(squeezedSizing.totalTokens > squeezedSizing.prefixTokens[2]);
  assert.equal(
    squeezedSizing.prefixTokens[2],
    firstMeasurement.inputTokens
    + firstMeasurement.outputTokens
    - CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS,
  );
});

test("a measured segment with no estimates to weigh is spent evenly", (): void => {
  const measurement: ChatHistoryMeasurement = {
    inputTokens: 10_000,
    outputTokens: 1_000,
    replayedMessages: 1,
  };
  const messages: ReadonlyArray<ServerChatMessage> = [
    { role: "user", content: [] },
    { role: "assistant", content: [], openaiItems: [], replayMeasurement: measurement },
  ];

  const sizing = measureChatHistory(messages);

  assert.equal(
    sizing.totalTokens,
    measurement.inputTokens
    + measurement.outputTokens
    - CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS,
  );
  assert.ok(sizing.prefixTokens[1] > 0);
  assert.ok(sizing.totalTokens - sizing.prefixTokens[1] > 0);
});

test("a legacy turn and an unusable measurement leave the session sizeable", (): void => {
  const messages: ReadonlyArray<ServerChatMessage> = [
    createUserMessage("First question"),
    // Stored before replay items were persisted: it replays nothing at all.
    { role: "assistant", content: [{ type: "text", text: "Legacy answer" }] },
    createUserMessage("Second question"),
    {
      ...createAssistantMessage("Second answer", undefined, []),
      replayMeasurement: parseChatHistoryMeasurement({
        inputTokens: Number.NaN,
        outputTokens: 1_000,
        replayedMessages: 3,
      }),
    },
  ];

  const sizing = measureChatHistory(messages);

  assert.ok(sizing.prefixTokens.every(
    (tokens) => Number.isInteger(tokens) && tokens >= 0,
  ));
  assert.equal(sizing.prefixTokens[2], sizing.prefixTokens[1]);
  const plan = planChatHistoryReplay(messages, TURN_INPUT);
  assert.equal(plan.startIndex, 0);
  assert.equal(plan.compactionItemIndex, null);
  assert.equal(plan.boundary, "none");
  assert.equal(plan.droppedMessages, 0);
  // Nothing was dropped, so the two reported sizes are the same one.
  assert.equal(plan.sentInputTokens, plan.unboundedSentInputTokens);
  // Grounded against the tokenizer: a row this module cannot size must still be
  // sized high, never low.
  assert.ok(
    plan.sentInputTokens >= realSentInputTokens(messages, 0, TURN_INPUT),
    `A legacy session really sends ${String(realSentInputTokens(messages, 0, TURN_INPUT))} `
    + `o200k tokens and is sized at ${String(plan.sentInputTokens)}`,
  );
});

test("a compaction item that still fits starts the replay", (): void => {
  const messages = createUnmeasuredSession(4, 2);

  const plan = planChatHistoryReplay(messages, TURN_INPUT);

  assert.equal(plan.boundary, "compaction");
  assert.equal(plan.startIndex, 5);
  assert.equal(plan.compactionItemIndex, 0);
  assert.ok(plan.sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS);
  assert.ok(plan.sentInputTokens < plan.unboundedSentInputTokens);
});

test("a compaction item the budget no longer accepts is dropped for the window", (): void => {
  const messages = createUnmeasuredSession(40, 1);

  const plan = planChatHistoryReplay(messages, TURN_INPUT);

  // The turns behind that item alone pass the budget, so it no longer stands
  // for a history that fits and the window has to bound this session instead.
  assert.equal(plan.boundary, "stale_compaction");
  assert.equal(plan.compactionItemIndex, null);
  assert.ok(plan.startIndex > 3);
  assert.equal(messages[plan.startIndex]?.role, "user");
  assert.ok(plan.sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS);
});

test("a turn larger than the whole budget keeps the newest question and its answer", (): void => {
  const messages: ReadonlyArray<ServerChatMessage> = [
    ...createUnmeasuredSession(1, null),
    createUserMessage("Newest question"),
    createAssistantMessage(
      "o".repeat(CHAT_SENT_INPUT_BUDGET_TOKENS * REAL_CHARACTERS_PER_TOKEN),
      undefined,
      [],
    ),
  ];

  const plan = planChatHistoryReplay(messages, TURN_INPUT);

  // No cut fits, so the pair the API already accepted is kept rather than the
  // session being erased, and the overflow is reported instead of hidden.
  assert.equal(plan.startIndex, 2);
  assert.equal(messages[plan.startIndex]?.role, "user");
  assert.equal(plan.boundary, "window");
  assert.ok(plan.sentInputTokens > CHAT_SENT_INPUT_BUDGET_TOKENS);
});

/**
 * Per-call overhead of the simulated provider: the real instructions, tool
 * schemas and clock cost 1,522 tokens, and this stays deliberately below
 * `CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS` instead of equal to it. Equality is
 * the one value at which a measurement is free to accept, so a simulation built
 * on it cannot see a reserve that has outgrown the real overhead and silently
 * put the whole session back on estimates.
 */
const SIMULATED_OVERHEAD_TOKENS = 1_600;

/** What the simulated provider would report as this call's `input_tokens`. */
const simulateSentInputTokens = (
  messages: ReadonlyArray<ServerChatMessage>,
  startIndex: number,
  question: string,
): number =>
  SIMULATED_OVERHEAD_TOKENS
  + messages
    .slice(startIndex)
    .reduce((total, message) => total + realMessageTokens(message), 0)
  + realTextTokens(question);

/** The measurement production stores for a completed turn. */
const simulateMeasurement = (
  messages: ReadonlyArray<ServerChatMessage>,
  startIndex: number,
  question: string,
  answer: string,
): ChatHistoryMeasurement => ({
  inputTokens: simulateSentInputTokens(messages, startIndex, question),
  outputTokens: realTextTokens(answer),
  // The assistant message lands right after the stored user turn, which this
  // call sent as the current turn.
  replayedMessages: messages.length + 1 - startIndex,
});

/**
 * Whether the sizing really used the measurement on the message at `index`, as
 * opposed to discarding it and charging the estimates. The suffix from the first
 * message that call covered equals its measured input plus output, less the
 * reserve, only when the measurement was adopted.
 */
const isMeasurementAdopted = (
  messages: ReadonlyArray<ServerChatMessage>,
  index: number,
): boolean => {
  const measurement = messages[index]?.replayMeasurement;
  if (measurement === undefined) {
    return false;
  }

  const sizing = measureChatHistory(messages.slice(0, index + 1));
  const coveredStart = Math.max(0, index - measurement.replayedMessages);

  return sizing.totalTokens - sizing.prefixTokens[coveredStart]
    === measurement.inputTokens
    + measurement.outputTokens
    - CHAT_SENT_INPUT_OVERHEAD_RESERVE_TOKENS;
};

test("a long measured session keeps every sent input inside the budget", (): void => {
  let messages: ReadonlyArray<ServerChatMessage> = [];
  let previousStartIndex = 0;
  let windowedTurns = 0;
  let adoptedMeasurements = 0;
  let maxSizedOverReal = 0;
  let maxRealSentInputTokens = 0;

  for (let turnIndex = 0; turnIndex < 80; turnIndex += 1) {
    const question = `Question ${String(turnIndex)} ${"q".repeat(TURN_TEXT_CHARACTERS)}`;
    const answer = `Answer ${String(turnIndex)} ${"a".repeat(TURN_TEXT_CHARACTERS)}`;
    const turnInput: ReadonlyArray<ContentPart> = [{ type: "text", text: question }];
    const plan = planChatHistoryReplay(messages, turnInput);
    // Exactly what production records for this call: the real overhead plus
    // everything the input carries.
    const sentInputTokens = simulateSentInputTokens(messages, plan.startIndex, question);

    assert.ok(
      sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS,
      `Turn ${String(turnIndex)} really sent ${String(sentInputTokens)} tokens, past the `
      + `${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
    );
    assert.ok(plan.sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS);
    // The replay boundary only ever moves forward, so the prompt-cache prefix
    // of the previous turn is never invalidated by the window alone.
    assert.ok(plan.startIndex >= previousStartIndex);
    previousStartIndex = plan.startIndex;
    windowedTurns += plan.boundary === "window" ? 1 : 0;
    maxRealSentInputTokens = Math.max(maxRealSentInputTokens, sentInputTokens);
    if (plan.boundary !== "none") {
      // Only once the window binds does the sizing have to be close: before
      // that the fixed reserve dominates a nearly empty history.
      maxSizedOverReal = Math.max(
        maxSizedOverReal,
        plan.sentInputTokens / sentInputTokens,
      );
    }

    messages = [
      ...messages,
      createUserMessage(question),
      createAssistantMessage(
        answer,
        simulateMeasurement(messages, plan.startIndex, question, answer),
        [],
      ),
    ];
    adoptedMeasurements += isMeasurementAdopted(messages, messages.length - 1) ? 1 : 0;
  }

  // The session outgrew the budget, so the bound was exercised rather than
  // merely never reached.
  assert.ok(measureChatHistory(messages).totalTokens > CHAT_SENT_INPUT_BUDGET_TOKENS);
  assert.ok(windowedTurns > 0);
  // The sizing tracked the measurements instead of quietly falling back to the
  // estimates. All three of these fail if the reserve is raised far enough above
  // the real overhead to price measurements out: the session then sizes itself
  // from estimates reading some 1.6x high and trims at about half the budget.
  assert.ok(
    adoptedMeasurements >= 79,
    `Only ${String(adoptedMeasurements)} of 80 turns were sized from their own `
    + "measurement",
  );
  assert.ok(
    maxSizedOverReal <= 1.05,
    `The window sized a bounded call at ${maxSizedOverReal.toFixed(2)}x what it `
    + "really sent",
  );
  assert.ok(
    maxRealSentInputTokens >= CHAT_SENT_INPUT_BUDGET_TOKENS * 0.9,
    `The session never sent more than ${String(maxRealSentInputTokens)} real `
    + `tokens, well under the ${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
  );
  // Identical history, identical boundary: the window never moves a prefix that
  // did not change.
  assert.deepEqual(
    planChatHistoryReplay(messages, TURN_INPUT),
    planChatHistoryReplay(messages, TURN_INPUT),
  );
});

test("the first measurements on an unmeasured session widen it without oscillating", (): void => {
  // Every session stored before measurements existed is sized entirely by
  // estimate on its next turn, and an estimate reads several times high - up to
  // 9x for Russian prose - so that first boundary drops turns that would have
  // fit. It is deliberately not allowed to become a floor: as measurements
  // replace those estimates the boundary steps back and the history returns.
  //
  // What must not happen is the attempt-2 symptom, a boundary that keeps
  // swinging. Each step back is a single widening paid once per measured turn,
  // so the series falls at most until the sizing is measured and then only
  // rises. Nothing clamps it: the append-only rule means a weight changes at
  // most once, from estimate to measurement, which bounds the backwards steps.
  let messages = createUnmeasuredSession(40, null);
  const startIndexes: Array<number> = [];

  for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
    const question = `Question ${String(turnIndex)} ${"q".repeat(TURN_TEXT_CHARACTERS)}`;
    const answer = `Answer ${String(turnIndex)} ${"a".repeat(TURN_TEXT_CHARACTERS)}`;
    const plan = planChatHistoryReplay(messages, [{ type: "text", text: question }]);
    startIndexes.push(plan.startIndex);
    assert.ok(
      plan.sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS,
      `Turn ${String(turnIndex)} of a recovering session sized ${String(plan.sentInputTokens)} `
      + `tokens, past the ${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
    );
    messages = [
      ...messages,
      createUserMessage(question),
      createAssistantMessage(
        answer,
        simulateMeasurement(messages, plan.startIndex, question, answer),
        [],
      ),
    ];
  }

  const series = startIndexes.join(", ");
  // The window was active throughout, so the series is not trivially flat at 0.
  assert.ok(startIndexes[0] > 0, `The window never bound: ${series}`);
  // Measurements recovered history the estimate had dropped.
  assert.ok(
    Math.min(...startIndexes) < startIndexes[0],
    `No history came back as the session was measured: ${series}`,
  );
  // One falling phase, then one rising phase: never a second reversal.
  const reversals = startIndexes.filter((startIndex, offset) => {
    const previous = startIndexes[offset - 1];
    const beforeThat = startIndexes[offset - 2];

    return previous !== undefined
      && beforeThat !== undefined
      && startIndex > previous
      && previous < beforeThat;
  }).length;
  assert.ok(reversals <= 1, `The replay boundary oscillated: ${series}`);
});

test("a measured session's boundary never pulls back", (): void => {
  // Attempt 2's failure class, and the guarantee that survives without any
  // boundary clamp: the append-only weight rule is what delivers it. A weight is
  // fixed when first assigned, so in a session measured from the start no
  // message ever gets cheaper, the total only grows, and the boundary only moves
  // forward - the prompt-cache prefix of the previous turn survives and turns
  // the user watched being dropped do not reappear.
  let messages: ReadonlyArray<ServerChatMessage> = [];
  const startIndexes: Array<number> = [];

  for (let turnIndex = 0; turnIndex < 40; turnIndex += 1) {
    const question = `Question ${String(turnIndex)} ${"q".repeat(TURN_TEXT_CHARACTERS)}`;
    const answer = `Answer ${String(turnIndex)} ${"a".repeat(TURN_TEXT_CHARACTERS)}`;
    const plan = planChatHistoryReplay(messages, [{ type: "text", text: question }]);
    startIndexes.push(plan.startIndex);
    messages = [
      ...messages,
      createUserMessage(question),
      createAssistantMessage(
        answer,
        simulateMeasurement(messages, plan.startIndex, question, answer),
        [],
      ),
    ];
  }

  const series = startIndexes.join(", ");
  assert.ok(Math.max(...startIndexes) > 0, `The window never bound: ${series}`);
  for (const [offset, startIndex] of startIndexes.entries()) {
    assert.ok(
      startIndex >= (startIndexes[offset - 1] ?? 0),
      `A measured session moved its replay boundary backwards: ${series}`,
    );
  }
});

test("a collapse decided by a container bound does not become permanent", (): void => {
  // A container the sizing path cannot read is charged the extracted-text cap -
  // here 714,334 tokens for two of them, against a real 2,000 - so no cut
  // reaches through that message and the window correctly keeps only the newest
  // pair for that one turn. What must not happen is that boundary latching: the
  // session replayed all 38 of its messages a turn earlier and the budget still
  // has room for every one of them.
  const container = (fileName: string): ContentPart => ({
    type: "file",
    fileName,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64Data: Buffer.from("x".repeat(40_000)).toString("base64"),
  });
  const question = "What changed in groceries this month? ".repeat(20);
  const answer = "Spending rose by 4% against plan. ".repeat(20);
  // What the two workbooks really cost once the provider has read them, which is
  // what makes the sizing's 714,334 a mis-estimate rather than the truth.
  const REAL_CONTAINER_TOKENS = 1_000;
  const realContentTokens = (content: ReadonlyArray<ContentPart>): number =>
    content.reduce(
      (total, part) => total + (part.type === "text"
        ? realTextTokens(part.text)
        : REAL_CONTAINER_TOKENS),
      0,
    );
  let messages: ReadonlyArray<ServerChatMessage> = [];
  const startIndexes: Array<number> = [];
  const runTurn = (turnInput: ReadonlyArray<ContentPart>): void => {
    const plan = planChatHistoryReplay(messages, turnInput);
    startIndexes.push(plan.startIndex);
    messages = [
      ...messages,
      { role: "user", content: turnInput },
      createAssistantMessage(answer, {
        inputTokens: SIMULATED_OVERHEAD_TOKENS
          + messages.slice(plan.startIndex).reduce(
            (total, message) => total + (message.role === "user"
              ? realContentTokens(message.content)
              : realMessageTokens(message)),
            0,
          )
          + realContentTokens(turnInput),
        outputTokens: realTextTokens(answer),
        replayedMessages: messages.length + 1 - plan.startIndex,
      }, []),
    ];
  };

  for (let turnIndex = 0; turnIndex < 20; turnIndex += 1) {
    runTurn([{ type: "text", text: `${question}${String(turnIndex)}` }]);
  }
  const collapsedTurn = startIndexes.length;
  runTurn([
    { type: "text", text: "Here are two sheets" },
    container("a.xlsx"),
    container("b.xlsx"),
  ]);
  for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
    runTurn([{ type: "text", text: `${question}after${String(turnIndex)}` }]);
  }

  const series = startIndexes.join(", ");
  // The containers' own turn is cut back, because sizing may not claim they fit.
  assert.ok(startIndexes[collapsedTurn] > 0, `The collapse never happened: ${series}`);
  // Every later turn replays the session again.
  for (const startIndex of startIndexes.slice(collapsedTurn + 1)) {
    assert.equal(
      startIndex,
      0,
      `A container bound latched the replay boundary: ${series}`,
    );
  }
});

test("a large turn trims only its own call", (): void => {
  // The window is chosen from the current turn's own size, so a turn carrying a
  // big attachment pushes the start forward for that call alone. The turn after
  // it gets the history back, because the budget allows it again - boundary
  // motion is not monotone, and that is the point: a floor built from one large
  // turn would have kept the rest of the session out of view for good.
  let messages: ReadonlyArray<ServerChatMessage> = [];
  for (let turnIndex = 0; turnIndex < 30; turnIndex += 1) {
    const question = `Question ${String(turnIndex)} ${"q".repeat(TURN_TEXT_CHARACTERS)}`;
    const answer = `Answer ${String(turnIndex)} ${"a".repeat(TURN_TEXT_CHARACTERS)}`;
    const plan = planChatHistoryReplay(messages, [{ type: "text", text: question }]);
    messages = [
      ...messages,
      createUserMessage(question),
      createAssistantMessage(
        answer,
        simulateMeasurement(messages, plan.startIndex, question, answer),
        [],
      ),
    ];
  }

  const largeQuestion = `Spreadsheet ${"s".repeat(TURN_TEXT_CHARACTERS * 8)}`;
  const largePlan = planChatHistoryReplay(
    messages,
    [{ type: "text", text: largeQuestion }],
  );
  const answer = "Answer";
  const withLargeTurn: ReadonlyArray<ServerChatMessage> = [
    ...messages,
    createUserMessage(largeQuestion),
    createAssistantMessage(
      answer,
      simulateMeasurement(messages, largePlan.startIndex, largeQuestion, answer),
      [],
    ),
  ];

  const shortPlan = planChatHistoryReplay(
    withLargeTurn,
    [{ type: "text", text: "ok, thanks" }],
  );

  // The large turn trimmed, and its own call fits.
  assert.ok(largePlan.startIndex > 0);
  assert.ok(largePlan.sentInputTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS);
  // The short turn after it replays more, and that larger history really fits -
  // which is what makes moving backwards safe.
  assert.ok(
    shortPlan.startIndex < largePlan.startIndex,
    `The short turn did not get the history back: ${String(largePlan.startIndex)} `
    + `then ${String(shortPlan.startIndex)}`,
  );
  const shortTurnRealTokens = SIMULATED_OVERHEAD_TOKENS
    + withLargeTurn.slice(shortPlan.startIndex).reduce(
      (total, message) => total + realMessageTokens(message),
      0,
    )
    + realTextTokens("ok, thanks");
  assert.ok(
    shortTurnRealTokens <= CHAT_SENT_INPUT_BUDGET_TOKENS,
    `Moving the boundary back sent ${String(shortTurnRealTokens)} real tokens, past `
    + `the ${String(CHAT_SENT_INPUT_BUDGET_TOKENS)} token budget`,
  );
});
