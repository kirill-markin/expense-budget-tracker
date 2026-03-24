type OutputTextDeltaProviderData = Readonly<{
  type: "response.output_text.delta";
  item_id: string;
  content_index: number;
  output_index: number;
  sequence_number?: number;
}>;

export type TextDeltaChunk = Readonly<{
  text: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  sequenceNumber: number | null;
}>;

type TextPartState = Readonly<{
  itemId: string;
  contentIndex: number;
  outputIndex: number;
  assembledText: string;
}>;

export type TextStreamState = ReadonlyMap<string, TextPartState>;

type TextStreamUpdate = Readonly<{
  textStates: TextStreamState;
  emittedDelta: TextDeltaChunk | null;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getRequiredStringField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  errorPrefix: string,
): string => {
  const candidate = value[key];
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  throw new Error(`${errorPrefix}: missing string field ${key}`);
};

const getOptionalNumberField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined => {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  throw new Error(`OpenAI event field ${key} must be a non-negative integer when present`);
};

const getRequiredNumberField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  errorPrefix: string,
): number => {
  const candidate = value[key];
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  throw new Error(`${errorPrefix}: missing non-negative integer field ${key}`);
};

const parseOutputTextDeltaProviderData = (
  providerData: unknown,
): OutputTextDeltaProviderData => {
  if (!isRecord(providerData)) {
    throw new Error("OpenAI output_text_delta is missing providerData");
  }
  const errorPrefix = `OpenAI output_text_delta providerData is invalid: ${JSON.stringify(providerData)}`;
  const type = getRequiredStringField(providerData, "type", errorPrefix);
  if (type !== "response.output_text.delta") {
    throw new Error(`${errorPrefix}: unexpected type ${type}`);
  }

  return {
    type: "response.output_text.delta",
    item_id: getRequiredStringField(providerData, "item_id", errorPrefix),
    content_index: getRequiredNumberField(providerData, "content_index", errorPrefix),
    output_index: getRequiredNumberField(providerData, "output_index", errorPrefix),
    sequence_number: getOptionalNumberField(providerData, "sequence_number"),
  };
};

const buildTextPartKey = (
  itemId: string,
  contentIndex: number,
): string =>
  `${itemId}:${String(contentIndex)}`;

const setTextPartState = (
  textStates: TextStreamState,
  nextState: TextPartState,
): TextStreamState => {
  const nextTextStates = new Map(textStates);
  nextTextStates.set(buildTextPartKey(nextState.itemId, nextState.contentIndex), nextState);
  return nextTextStates;
};

export const createTextStreamState = (): TextStreamState => new Map();

export const applyOutputTextDelta = (
  textStates: TextStreamState,
  chunk: TextDeltaChunk,
): TextStreamUpdate => {
  const key = buildTextPartKey(chunk.itemId, chunk.contentIndex);
  const previousState = textStates.get(key);

  if (previousState !== undefined && previousState.outputIndex !== chunk.outputIndex) {
    throw new Error(
      `OpenAI output_text.delta changed output_index for item_id=${chunk.itemId} content_index=${String(chunk.contentIndex)} from ${String(previousState.outputIndex)} to ${String(chunk.outputIndex)}`,
    );
  }

  const nextState: TextPartState = {
    itemId: chunk.itemId,
    contentIndex: chunk.contentIndex,
    outputIndex: chunk.outputIndex,
    assembledText: (previousState?.assembledText ?? "") + chunk.text,
  };

  return {
    textStates: setTextPartState(textStates, nextState),
    emittedDelta: chunk.text.length > 0 ? chunk : null,
  };
};

export const applyRawTextStreamEvent = (
  textStates: TextStreamState,
  event: Readonly<{
    type: string;
    delta?: string;
    providerData?: unknown;
    event?: unknown;
  }>,
): TextStreamUpdate => {
  if (event.type !== "output_text_delta") {
    return {
      textStates,
      emittedDelta: null,
    };
  }

  const providerData = parseOutputTextDeltaProviderData(event.providerData);
  if (typeof event.delta !== "string") {
    throw new Error(`OpenAI output_text_delta is missing delta for item_id=${providerData.item_id}`);
  }

  return applyOutputTextDelta(textStates, {
    text: event.delta,
    itemId: providerData.item_id,
    outputIndex: providerData.output_index,
    contentIndex: providerData.content_index,
    sequenceNumber: providerData.sequence_number ?? null,
  });
};
