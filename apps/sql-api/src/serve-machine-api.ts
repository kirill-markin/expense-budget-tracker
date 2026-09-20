/**
 * Container entry point for the /v1 machine API.
 *
 * Serves the same handler the API Gateway Lambda serves, over plain HTTP.
 */

import { serve } from "@hono/node-server";
import { log } from "./logger.js";
import { createDefaultMachineApiFetch } from "./machineApiHttp.js";
import { readRequiredPort } from "./serverPort.js";

const port = readRequiredPort(process.env);

serve({ fetch: createDefaultMachineApiFetch(), port, hostname: "0.0.0.0" }, (info) => {
  log({ domain: "sql_api", action: "container_started", surface: "machine_api", port: info.port });
});
