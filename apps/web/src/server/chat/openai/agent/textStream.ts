type OutputTextDeltaProviderData = Readonly<{
  type: "response.output_text.delta";
  item_id: string;
  content_index: number;
  output_index: number;
  sequence_number?: number;
}>;

type OutputTextDeltaEvent = Readonly<{
  type: "response.output_text.delta";
  item_id: string;
  content_index: number;
  output_index: number;
  sequence_number: number;
  delta: string;
}>;

type OutputTextDoneEvent = Readonly<{
  type: "response.output_text.done";
  item_id: string;
  content_index: number;
  output_index: number;
  text: string;
}>;

type OutputItemDoneEvent = Readonly<{
  type: "response.output_item.done";
  output_index: number;
  item: Readonly<{
    id: string;
    type: string;
  }>;
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
  doneText: string | null;
  isDone: boolean;
}>;

export type TextStreamState = ReadonlyMap<string, TextPartState>;

type TextStreamUpdate = Readonly<{
  textStates: TextStreamState;
  emittedDelta: TextDeltaChunk | null;
}>;

const MAX_LOG_SNIPPET_LENGTH = 400;

const truncateForLog = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length <= MAX_LOG_SNIPPET_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_LOG_SNIPPET_LENGTH) + "...[truncated]";
};

const formatTextMismatchError = (
  itemId: string,
  contentIndex: number,
  outputIndex: number,
  assembledText: string,
  doneText: string,
): string =>
  `OpenAI output_text.done mismatch for item_id=${itemId} content_index=${String(contentIndex)} output_index=${String(outputIndex)} assembled_len=${String(assembledText.length)} done_len=${String(doneText.length)} assembled=${truncateForLog(assembledText) ?? ""} done=${truncateForLog(doneText) ?? ""}`;

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

const parseOutputTextDeltaEvent = (
  rawEvent: unknown,
): OutputTextDeltaEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.output_text.delta") {
    return null;
  }

  const errorPrefix = `OpenAI response.output_text.delta event is invalid: ${JSON.stringify(rawEvent)}`;
  return {
    type: "response.output_text.delta",
    item_id: getRequiredStringField(rawEvent, "item_id", errorPrefix),
    content_index: getRequiredNumberField(rawEvent, "content_index", errorPrefix),
    output_index: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    sequence_number: getRequiredNumberField(rawEvent, "sequence_number", errorPrefix),
    delta: getRequiredStringField(rawEvent, "delta", errorPrefix),
  };
};

const parseOutputTextDoneEvent = (
  rawEvent: unknown,
): OutputTextDoneEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.output_text.done") {
    return null;
  }
  const errorPrefix = `OpenAI response.output_text.done event is invalid: ${JSON.stringify(rawEvent)}`;
  return {
    type: "response.output_text.done",
    item_id: getRequiredStringField(rawEvent, "item_id", errorPrefix),
    content_index: getRequiredNumberField(rawEvent, "content_index", errorPrefix),
    output_index: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    text: getRequiredStringField(rawEvent, "text", errorPrefix),
  };
};

const parseOutputItemDoneEvent = (
  rawEvent: unknown,
): OutputItemDoneEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.output_item.done") {
    return null;
  }
  const errorPrefix = `OpenAI response.output_item.done event is invalid: ${JSON.stringify(rawEvent)}`;
  const rawItem = rawEvent.item;
  if (!isRecord(rawItem)) {
    throw new Error(`${errorPrefix}: missing item object`);
  }

  return {
    type: "response.output_item.done",
    output_index: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    item: {
      id: getRequiredStringField(rawItem, "id", errorPrefix),
      type: getRequiredStringField(rawItem, "type", errorPrefix),
    },
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

  if (previousState !== undefined) {
    if (previousState.isDone) {
      throw new Error(
        `OpenAI output_text.delta arrived after output_text.done for item_id=${chunk.itemId} content_index=${String(chunk.contentIndex)} output_index=${String(chunk.outputIndex)}`,
      );
    }
    if (previousState.outputIndex !== chunk.outputIndex) {
      throw new Error(
        `OpenAI output_text.delta changed output_index for item_id=${chunk.itemId} content_index=${String(chunk.contentIndex)} from ${String(previousState.outputIndex)} to ${String(chunk.outputIndex)}`,
      );
    }
  }

  const nextState: TextPartState = {
    itemId: chunk.itemId,
    contentIndex: chunk.contentIndex,
    outputIndex: chunk.outputIndex,
    assembledText: (previousState?.assembledText ?? "") + chunk.text,
    doneText: previousState?.doneText ?? null,
    isDone: false,
  };

  return {
    textStates: setTextPartState(textStates, nextState),
    emittedDelta: chunk.text.length > 0 ? chunk : null,
  };
};

export const applyOutputTextDone = (
  textStates: TextStreamState,
  doneEvent: OutputTextDoneEvent,
): TextStreamUpdate => {
  const key = buildTextPartKey(doneEvent.item_id, doneEvent.content_index);
  const previousState = textStates.get(key);
  const assembledText = previousState?.assembledText ?? "";

  if (previousState !== undefined && previousState.outputIndex !== doneEvent.output_index) {
    throw new Error(
      `OpenAI output_text.done changed output_index for item_id=${doneEvent.item_id} content_index=${String(doneEvent.content_index)} from ${String(previousState.outputIndex)} to ${String(doneEvent.output_index)}`,
    );
  }

  if (assembledText !== doneEvent.text) {
    throw new Error(
      formatTextMismatchError(
        doneEvent.item_id,
        doneEvent.content_index,
        doneEvent.output_index,
        assembledText,
        doneEvent.text,
      ),
    );
  }

  const nextState: TextPartState = {
    itemId: doneEvent.item_id,
    contentIndex: doneEvent.content_index,
    outputIndex: doneEvent.output_index,
    assembledText,
    doneText: doneEvent.text,
    isDone: true,
  };

  return {
    textStates: setTextPartState(textStates, nextState),
    emittedDelta: null,
  };
};

export const applyOutputItemDone = (
  textStates: TextStreamState,
  doneEvent: OutputItemDoneEvent,
): TextStreamUpdate => {
  if (doneEvent.item.type !== "message") {
    return {
      textStates,
      emittedDelta: null,
    };
  }

  for (const state of textStates.values()) {
    if (state.itemId !== doneEvent.item.id) {
      continue;
    }
    if (state.outputIndex !== doneEvent.output_index) {
      throw new Error(
        `OpenAI output_item.done changed output_index for item_id=${doneEvent.item.id} from ${String(state.outputIndex)} to ${String(doneEvent.output_index)}`,
      );
    }
    if (!state.isDone) {
      throw new Error(
        `OpenAI output_item.done arrived before output_text.done for item_id=${doneEvent.item.id} content_index=${String(state.contentIndex)} output_index=${String(doneEvent.output_index)}`,
      );
    }
  }

  return {
    textStates,
    emittedDelta: null,
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
  if (event.type === "output_text_delta") {
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
  }

  if (event.type === "model") {
    const textDeltaEvent = parseOutputTextDeltaEvent(event.event);
    if (textDeltaEvent !== null) {
      return applyOutputTextDelta(textStates, {
        text: textDeltaEvent.delta,
        itemId: textDeltaEvent.item_id,
        outputIndex: textDeltaEvent.output_index,
        contentIndex: textDeltaEvent.content_index,
        sequenceNumber: textDeltaEvent.sequence_number,
      });
    }

    const doneEvent = parseOutputTextDoneEvent(event.event);
    if (doneEvent !== null) {
      return applyOutputTextDone(textStates, doneEvent);
    }

    const outputItemDoneEvent = parseOutputItemDoneEvent(event.event);
    if (outputItemDoneEvent !== null) {
      return applyOutputItemDone(textStates, outputItemDoneEvent);
    }
  }

  return {
    textStates,
    emittedDelta: null,
  };
};
