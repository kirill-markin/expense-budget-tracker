import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDiscoveryEnvelope } from "@expense-budget-tracker/agent-shared/discovery";
import { createMachineApiHandler } from "./machineApi.js";
import { createEvent } from "./handlerTestUtils.js";

test("root discovery matches /agent", async () => {
  const handler = createMachineApiHandler({
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
  });

  const rootResponse = await handler(createEvent({ path: "/", resource: "/" }));
  const agentResponse = await handler(createEvent({ path: "/agent", resource: "/agent" }));

  assert.equal(rootResponse.statusCode, 200);
  assert.equal(agentResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(rootResponse.body), JSON.parse(agentResponse.body));

  const body = JSON.parse(rootResponse.body) as { instructions: string };
  assert.match(body.instructions, /Ask the user for their email address first/i);
  assert.match(body.instructions, /same email OTP flow handles both signup and login/i);
  assert.match(body.instructions, /\.env file as EXPENSE_BUDGET_TRACKER_API_KEY='<PASTE_KEY_HERE>'/i);
  assert.match(body.instructions, /Authorization: ApiKey \$EXPENSE_BUDGET_TRACKER_API_KEY/);
});

test("root discovery matches the shared discovery contract", async () => {
  const handler = createMachineApiHandler({
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
  });

  const response = await handler(createEvent({ path: "/", resource: "/" }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    JSON.parse(response.body),
    buildAgentDiscoveryEnvelope({
      apiBaseUrl: "https://api.example.com/v1",
      authBaseUrl: "https://auth.example.com",
      bootstrapUrl: "https://auth.example.com/api/agent/send-code",
    }),
  );
});

test("openapi and swagger endpoints return the same document", async () => {
  const handler = createMachineApiHandler({
    loadOpenApiDocument: () => ({ openapi: "3.1.0", info: { title: "Expense API" } }),
  });

  const openapiResponse = await handler(createEvent({ path: "/openapi.json", resource: "/openapi.json" }));
  const swaggerResponse = await handler(createEvent({ path: "/swagger.json", resource: "/swagger.json" }));

  assert.equal(openapiResponse.statusCode, 200);
  assert.equal(swaggerResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(openapiResponse.body), JSON.parse(swaggerResponse.body));
});
