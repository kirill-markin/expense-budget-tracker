import type { APIGatewayProxyResult } from "aws-lambda";
import { buildErrorEnvelope } from "@expense-budget-tracker/agent-shared";

export const json = (statusCode: number, body: Readonly<Record<string, unknown>>): APIGatewayProxyResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const buildRetryableErrorResponse = (
  code: string,
  instructions: string,
  error: unknown,
  details: Readonly<Record<string, unknown>>,
): APIGatewayProxyResult =>
  json(
    500,
    buildErrorEnvelope(
      details,
      [],
      instructions,
      code,
      getErrorMessage(error),
    ),
  );
