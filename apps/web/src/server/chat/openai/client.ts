import OpenAI from "openai";
import { observeOpenAI } from "@langfuse/openai";

let rawClient: OpenAI | null = null;
let observedClient: OpenAI | null = null;

const getApiKey = (): string => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }

  return apiKey;
};

export const getOpenAIClient = (): OpenAI => {
  if (rawClient !== null) {
    return rawClient;
  }

  rawClient = new OpenAI({
    apiKey: getApiKey(),
  });
  return rawClient;
};

export const getObservedOpenAIClient = (): OpenAI => {
  if (observedClient !== null) {
    return observedClient;
  }

  observedClient = observeOpenAI(getOpenAIClient());
  return observedClient;
};
