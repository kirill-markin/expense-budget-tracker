import { createHash } from "node:crypto";

const SAFETY_IDENTIFIER_VERSION = "v1";

export const buildOpenAISafetyIdentifier = (
  userId: string,
): string => {
  if (userId.length === 0) {
    throw new Error("Cannot build OpenAI safety identifier from an empty userId");
  }

  const digest = createHash("sha256")
    .update(userId, "utf8")
    .digest("base64url");

  return `${SAFETY_IDENTIFIER_VERSION}_${digest}`;
};
