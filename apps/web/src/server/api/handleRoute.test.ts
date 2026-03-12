import assert from "node:assert/strict";
import test from "node:test";

import { createBadRequestError } from "./errors";
import { handleRoute } from "./handleRoute";

test("handleRoute returns ApiRouteError responses without logging", async () => {
  const messages: Array<string> = [];
  const originalLog = console.log;
  console.log = (value?: unknown): void => {
    messages.push(String(value));
  };

  try {
    const response = await handleRoute(
      { route: "/api/test", method: "GET", internalErrorMessage: "Database query failed" },
      async (): Promise<Response> => {
        throw createBadRequestError("Invalid month format. Expected YYYY-MM");
      },
    );

    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid month format. Expected YYYY-MM");
    assert.deepEqual(messages, []);
  } finally {
    console.log = originalLog;
  }
});

test("handleRoute logs unexpected failures and returns the configured 500 message", async () => {
  const messages: Array<string> = [];
  const originalLog = console.log;
  console.log = (value?: unknown): void => {
    messages.push(String(value));
  };

  try {
    const response = await handleRoute(
      { route: "/api/test", method: "GET", internalErrorMessage: "Database query failed" },
      async (): Promise<Response> => {
        throw new Error("boom");
      },
    );

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Database query failed");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /"route":"\/api\/test"/);
    assert.match(messages[0], /"error":"boom"/);
  } finally {
    console.log = originalLog;
  }
});
