import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { ApiRouteError, fromZodError } from "./errors";
import { monthSchema, parseJsonBody, parseOptionalQueryParam, parseRepeatedQueryParam, parseRequiredQueryParam } from "./validation";

test("parseJsonBody returns 400 Invalid JSON body for malformed JSON", async () => {
  const request = new Request("https://example.com", { method: "POST", body: "{" });

  await assert.rejects(
    (): Promise<unknown> => parseJsonBody(request, z.object({ month: monthSchema })),
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.status === 400
      && error.publicMessage === "Invalid JSON body",
  );
});

test("parseJsonBody returns the first schema issue message", async () => {
  const request = new Request("https://example.com", {
    method: "POST",
    body: JSON.stringify({ month: "2026-13" }),
  });

  await assert.rejects(
    (): Promise<unknown> => parseJsonBody(request, z.object({ month: monthSchema })),
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid month format. Expected YYYY-MM",
  );
});

test("parseJsonBody returns typed data for valid input", async () => {
  const request = new Request("https://example.com", {
    method: "POST",
    body: JSON.stringify({ month: "2026-03" }),
  });

  const result = await parseJsonBody(request, z.object({ month: monthSchema }));

  assert.deepEqual(result, { month: "2026-03" });
});

test("fromZodError uses the first schema-defined issue message", () => {
  const error = new z.ZodError([
    { code: "custom", message: "First issue", path: ["month"] },
    { code: "custom", message: "Second issue", path: ["category"] },
  ]);

  const routeError = fromZodError(error);

  assert.equal(routeError.publicMessage, "First issue");
  assert.equal(routeError.status, 400);
});

test("parseRequiredQueryParam returns the missing-parameter message", () => {
  assert.throws(
    (): void => {
      parseRequiredQueryParam(new URLSearchParams(), "month", monthSchema, "Missing required query param: month");
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Missing required query param: month",
  );
});

test("parseOptionalQueryParam returns validation errors for present invalid values", () => {
  assert.throws(
    (): void => {
      parseOptionalQueryParam(new URLSearchParams("month=2026-13"), "month", monthSchema);
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid month format. Expected YYYY-MM",
  );
});

test("parseRepeatedQueryParam fails on the first invalid repeated value", () => {
  const schema = z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || value.length > 2) {
      ctx.addIssue({ code: "custom", message: "categories entry too long (max 200 chars)" });
    }
  }).transform((value): string => value as string);

  assert.throws(
    (): void => {
      parseRepeatedQueryParam(new URLSearchParams("categories=ok&categories=toolong"), "categories", schema);
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "categories entry too long (max 200 chars)",
  );
});
