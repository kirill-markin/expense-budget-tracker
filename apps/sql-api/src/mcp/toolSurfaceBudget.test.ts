import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ListToolsResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_SQL_RESULT_CHARS,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import { MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS, type McpServerDependencies } from "./server.js";
import { withMcpClient } from "./testClient.js";

// Anthropic directory tool-name policy and OpenAI tool naming limit.
const MAX_TOOL_NAME_CHARS = 64;
// OpenAI tool and parameter description limit.
const MAX_DESCRIPTION_CHARS = 1024;
// OpenAI server instructions limit.
const MAX_SERVER_INSTRUCTIONS_CHARS = 2000;
// OpenAI guidance to carry the decisive instruction content in the opening characters.
const LEAD_INSTRUCTIONS_CHARS = 512;
// OpenAI caps all tool definitions at 5000 tokens; 4000 keeps headroom.
const MAX_TOOLS_LIST_TOKENS = 4000;
// MCP Registry server.schema.json maxLength for description and title.
const MAX_REGISTRY_TEXT_CHARS = 100;
// One get_guide result has to stay small enough to sit beside a real task in context.
const MAX_GUIDE_RESULT_CHARS = 20_000;

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const REQUIRED_LEAD_TOOL_NAMES = [
  "list_workspaces",
  "get_schema",
  "get_guide",
  "sql_query",
  "sql_execute",
] as const;

const GUIDE_TOPICS = ["sql_dialect", "writing_data", "query_recipes"] as const;

const PUBLISHER_META_KEY = "io.modelcontextprotocol.registry/publisher-provided";
const MAX_RESULT_SIZE_META_KEY = "anthropic/maxResultSizeChars";
const SQL_TOOL_NAMES = ["sql_query", "sql_execute"] as const;

const registryServerSchema = z.object({
  title: z.string(),
  description: z.string(),
  _meta: z.object({
    [PUBLISHER_META_KEY]: z.object({
      tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
      })),
    }),
  }),
});

const inputPropertySchema = z.object({ description: z.string().optional() });
const textContentSchema = z.object({ type: z.literal("text"), text: z.string() });
const successResultSchema = z.object({
  ok: z.literal(true),
  data: z.record(z.string(), z.unknown()),
  instructions: z.string(),
});

const toolSurfaceConnection: AuthenticatedMcpAccessToken = {
  connectionId: "connection-budget",
  clientId: "client-budget",
  resource: "https://mcp.example.com/mcp",
  scopes: ["expenses:read", "expenses:write"],
  identity: {
    userId: "user-budget",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
};

const rejectUnusedDataService = (serviceName: string): Promise<never> =>
  Promise.reject(new Error(
    `The MCP tool surface budget test must not reach ${serviceName}; it reads tools/list and instructions only.`,
  ));

const toolSurfaceDependencies: McpServerDependencies = {
  listWorkspaces: () => rejectUnusedDataService("listWorkspaces"),
  getWorkspace: () => rejectUnusedDataService("getWorkspace"),
  loadAllowedSchemaForWorkspace: () => rejectUnusedDataService("loadAllowedSchemaForWorkspace"),
  runReadOnlySql: () => rejectUnusedDataService("runReadOnlySql"),
  runSql: () => rejectUnusedDataService("runSql"),
  validateSingleReadOnlyExpenseSql,
  validateSingleMutationExpenseSql,
};

// Result-shape checks have to reach the tool handlers, so they need serving stubs
// instead of the rejecting ones used by the tools/list and instructions budgets.
const RESULT_WORKSPACE_ID = "workspace-personal";

const toolResultDependencies: McpServerDependencies = {
  listWorkspaces: async () => [{ workspaceId: RESULT_WORKSPACE_ID, name: "Personal" }],
  getWorkspace: async () => ({ workspaceId: RESULT_WORKSPACE_ID, name: "Personal" }),
  loadAllowedSchemaForWorkspace: async () => [{
    name: "ledger_entries",
    columns: [{ name: "amount", type: "numeric", nullable: false, defaultValue: null }],
  }],
  validateSingleReadOnlyExpenseSql,
  validateSingleMutationExpenseSql,
  runReadOnlySql: async (_authenticated, workspaceId, validated, deadline) => ({
    statements: [{
      sql: validated.sql,
      command: "SELECT",
      rows: [{ amount: "10.00" }],
      rowCount: 1,
      returnedRowCount: 1,
      totalRowCount: 1,
      truncated: false,
      referencedRelations: ["ledger_entries"],
    }],
    workspace: { workspaceId, name: "Personal" },
    limits: { maxRows: 100, maxResultChars: MAX_SQL_RESULT_CHARS, statementTimeoutMs: deadline.timeoutMs },
  }),
  runSql: async (_authenticated, workspaceId, validated, deadline) => ({
    statements: [{
      sql: validated.sql,
      command: "DELETE",
      rows: [],
      rowCount: 1,
      returnedRowCount: 0,
      totalRowCount: 1,
      truncated: false,
      referencedRelations: ["budget_lines"],
    }],
    workspace: { workspaceId, name: "Personal" },
    limits: { maxRows: 100, maxResultChars: MAX_SQL_RESULT_CHARS, statementTimeoutMs: deadline.timeoutMs },
  }),
};

type ToolSurface = Readonly<{
  toolsList: ListToolsResult;
  instructions: string;
}>;

const readToolSurface = (): Promise<ToolSurface> => withMcpClient(
  "mcp-tool-surface-budget-test",
  toolSurfaceConnection,
  toolSurfaceDependencies,
  async (client): Promise<ToolSurface> => {
    const toolsList = await client.listTools();
    const instructions = client.getInstructions();
    assert.ok(instructions !== undefined, "Expected the MCP server to advertise instructions");
    return { toolsList, instructions };
  },
);

const assertWithinBudget = (label: string, actual: number, budget: number): void => {
  assert.ok(
    actual <= budget,
    `${label} is ${String(actual)} and exceeds the ${String(budget)} budget`,
  );
};

const assertToolWithinBudgets = (tool: Tool): void => {
  assertWithinBudget(`Tool name ${tool.name}`, tool.name.length, MAX_TOOL_NAME_CHARS);
  assert.match(tool.name, TOOL_NAME_PATTERN);
  assert.ok(tool.title !== undefined, `Expected ${tool.name} to declare a title`);
  assert.ok(tool.description !== undefined, `Expected ${tool.name} to declare a description`);
  assertWithinBudget(
    `Tool ${tool.name} description`,
    tool.description.length,
    MAX_DESCRIPTION_CHARS,
  );

  const inputProperties: Readonly<Record<string, unknown>> = tool.inputSchema.properties ?? {};
  for (const [property, schema] of Object.entries(inputProperties)) {
    const { description } = inputPropertySchema.parse(schema);
    if (description === undefined) {
      continue;
    }
    assertWithinBudget(
      `Tool ${tool.name} input property ${property} description`,
      description.length,
      MAX_DESCRIPTION_CHARS,
    );
  }

  const annotations = tool.annotations;
  assert.ok(annotations !== undefined, `Expected ${tool.name} to declare annotations`);
  assert.equal(
    typeof annotations.readOnlyHint,
    "boolean",
    `Expected ${tool.name} to declare readOnlyHint`,
  );
  assert.equal(
    typeof annotations.destructiveHint,
    "boolean",
    `Expected ${tool.name} to declare destructiveHint`,
  );
};

test("MCP tool definitions stay within vendor name and description budgets", async (): Promise<void> => {
  const { toolsList } = await readToolSurface();

  assert.ok(toolsList.tools.length > 0, "Expected tools/list to advertise at least one tool");
  for (const tool of toolsList.tools) {
    assertToolWithinBudgets(tool);
  }
});

test("MCP server instructions lead with the tool flow within the instruction budget", async (): Promise<void> => {
  const { instructions } = await readToolSurface();

  assertWithinBudget("Server instructions", instructions.length, MAX_SERVER_INSTRUCTIONS_CHARS);
  const lead = instructions.slice(0, LEAD_INSTRUCTIONS_CHARS);
  for (const toolName of REQUIRED_LEAD_TOOL_NAMES) {
    assert.ok(
      lead.includes(toolName),
      `Expected the first ${String(LEAD_INSTRUCTIONS_CHARS)} instruction characters to mention ${toolName}`,
    );
  }
});

test("MCP tools/list stays within the OpenAI tool definition token budget", async (): Promise<void> => {
  const { toolsList } = await readToolSurface();

  const tokens = getEncoding("o200k_base").encode(JSON.stringify(toolsList));
  assertWithinBudget("tools/list token count", tokens.length, MAX_TOOLS_LIST_TOKENS);
});

test("SQL tools declare a result size budget that covers the emitted envelope", async (): Promise<void> => {
  const { toolsList } = await readToolSurface();

  for (const toolName of SQL_TOOL_NAMES) {
    const tool = toolsList.tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool !== undefined, `Expected tools/list to advertise ${toolName}`);
    assert.equal(
      tool._meta?.[MAX_RESULT_SIZE_META_KEY],
      MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS,
      `${toolName} must declare ${MAX_RESULT_SIZE_META_KEY} equal to the declared SQL result ceiling`,
    );
  }

  // The shared SQL budget bounds the data payload alone, so the declared ceiling
  // has to stay at or above what a maximally packed result actually emits: the
  // full data budget plus the ok and instructions envelope around it.
  await withMcpClient(
    "mcp-tool-surface-budget-test",
    toolSurfaceConnection,
    toolResultDependencies,
    async (client): Promise<void> => {
      const results = [
        {
          toolName: "sql_query",
          result: await client.callTool({
            name: "sql_query",
            arguments: { sql: "SELECT amount FROM ledger_entries" },
          }),
        },
        {
          toolName: "sql_execute",
          result: await client.callTool({
            name: "sql_execute",
            arguments: { sql: "DELETE FROM budget_lines WHERE category = 'Food'" },
          }),
        },
      ];
      for (const { toolName, result } of results) {
        assert.notEqual(result.isError, true);
        assert.ok(Array.isArray(result.content));
        const { text } = textContentSchema.parse(result.content[0]);
        const parsed: unknown = JSON.parse(text);
        const payload = successResultSchema.parse(parsed);
        const envelopeChars = text.length - JSON.stringify(payload.data).length;
        assert.ok(
          MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS >= MAX_SQL_RESULT_CHARS + envelopeChars,
          `${toolName} emits a ${String(envelopeChars)} character envelope, so ${MAX_RESULT_SIZE_META_KEY} must declare at least ${String(MAX_SQL_RESULT_CHARS + envelopeChars)} rather than ${String(MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS)}`,
        );
      }
    },
  );
});

test("no MCP tool declares an output schema", async (): Promise<void> => {
  const { toolsList } = await readToolSurface();

  assert.ok(toolsList.tools.length > 0, "Expected tools/list to advertise at least one tool");
  for (const tool of toolsList.tools) {
    assert.equal(tool.outputSchema, undefined, `${tool.name} must not declare outputSchema`);
  }
});

test("MCP results carry no structuredContent duplicate of the text block", async (): Promise<void> => {
  await withMcpClient(
    "mcp-tool-surface-budget-test",
    toolSurfaceConnection,
    toolResultDependencies,
    async (client): Promise<void> => {
      const results = [
        await client.callTool({ name: "list_workspaces", arguments: {} }),
        await client.callTool({ name: "get_schema", arguments: {} }),
        await client.callTool({ name: "get_guide", arguments: { topic: "writing_data" } }),
        await client.callTool({
          name: "sql_query",
          arguments: { sql: "SELECT amount FROM ledger_entries" },
        }),
        await client.callTool({
          name: "sql_execute",
          arguments: { sql: "DELETE FROM budget_lines WHERE category = 'Food'" },
        }),
      ];
      for (const result of results) {
        assert.notEqual(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.ok(Array.isArray(result.content));
        assert.equal(result.content.length, 1);
      }
    },
  );
});

test("each get_guide topic result stays within the guide payload budget", async (): Promise<void> => {
  await withMcpClient(
    "mcp-tool-surface-budget-test",
    toolSurfaceConnection,
    toolSurfaceDependencies,
    async (client): Promise<void> => {
      for (const topic of GUIDE_TOPICS) {
        const result = await client.callTool({ name: "get_guide", arguments: { topic } });
        assert.notEqual(result.isError, true);
        assert.ok(Array.isArray(result.content));
        assert.equal(result.content.length, 1);
        const { text } = textContentSchema.parse(result.content[0]);
        assertWithinBudget(`get_guide ${topic} result`, text.length, MAX_GUIDE_RESULT_CHARS);
      }
    },
  );
});

// The manifest sits four directories above this file both as src/mcp and as built dist/mcp.
const readRegistryManifest = (): string => {
  const manifestPath = fileURLToPath(new URL("../../../../server.json", import.meta.url));
  try {
    return readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `The MCP tool surface budget test could not read the MCP Registry manifest at ${manifestPath}; update this path if the repository root server.json moved or the package layout changed`,
      { cause: error },
    );
  }
};

test("MCP Registry server manifest text stays within the registry length limits", (): void => {
  const manifestJson: unknown = JSON.parse(readRegistryManifest());
  const manifest = registryServerSchema.parse(manifestJson);

  assertWithinBudget("Registry title", manifest.title.length, MAX_REGISTRY_TEXT_CHARS);
  assertWithinBudget(
    "Registry description",
    manifest.description.length,
    MAX_REGISTRY_TEXT_CHARS,
  );
  for (const tool of manifest._meta[PUBLISHER_META_KEY].tools) {
    assertWithinBudget(
      `Registry tool ${tool.name} description`,
      tool.description.length,
      MAX_REGISTRY_TEXT_CHARS,
    );
  }
});
