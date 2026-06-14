import { randomBytes } from "node:crypto";

const MONTHLY_CATEGORY_SHARE_TOKEN_BYTES = 32;

export const generateMonthlyCategoryShareToken = (): string =>
  randomBytes(MONTHLY_CATEGORY_SHARE_TOKEN_BYTES).toString("base64url");
