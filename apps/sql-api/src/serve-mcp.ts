/**
 * Container entry point for the MCP server.
 *
 * Serves the same Hono app the MCP Lambda serves, over plain HTTP, behind the
 * container request body ceiling. The MCP transport runs in stateless JSON
 * mode, so no response is streamed.
 */

import { serve } from "@hono/node-server";
import { log } from "./logger.js";
import { createDefaultMcpFetch } from "./mcpHttp.js";
import { readRequiredPort } from "./serverPort.js";

const port = readRequiredPort(process.env);

serve({ fetch: createDefaultMcpFetch(), port, hostname: "0.0.0.0" }, (info) => {
  log({ domain: "sql_api", action: "container_started", surface: "mcp", port: info.port });
});
