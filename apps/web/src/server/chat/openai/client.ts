import OpenAI from "openai";

let rawClient: OpenAI | null = null;

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
