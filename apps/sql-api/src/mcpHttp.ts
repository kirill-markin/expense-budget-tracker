import type { Hono } from "hono";
import { createDefaultMcpApp } from "./mcp-handler.js";
import { MCP_MAX_REQUEST_BODY_BYTES } from "./mcp/limits.js";
import {
  RequestBodyTooLargeError,
  readBoundedRequestBytes,
} from "./requestBodyLimit.js";

export type McpFetch = (request: Request) => Promise<Response>;

// The MCP transport parses a buffered JSON body, so replaying the bounded
// bytes as the request body loses nothing the app reads. The bytes are never
// decoded, so the replayed body and the copied Content-Length still agree, and
// the client-disconnect signal is forwarded rather than replaced by a fresh
// one that never aborts.
const bufferRequestWithinLimit = async (request: Request, maxBytes: number): Promise<Request> => {
  if (request.body === null) {
    return request;
  }

  const body = await readBoundedRequestBytes(request, "MCP", maxBytes);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
};

const buildRequestBodyTooLargeResponse = (error: RequestBodyTooLargeError): Response => new Response(
  JSON.stringify({
    error: "payload_too_large",
    error_description: `The MCP request body must not exceed ${String(error.maxBytes)} bytes.`,
  }),
  { status: 413, headers: { "content-type": "application/json" } },
);

export const createBoundedMcpFetch = (app: Hono): McpFetch => async (request: Request): Promise<Response> => {
  let bounded: Request;
  try {
    bounded = await bufferRequestWithinLimit(request, MCP_MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return buildRequestBodyTooLargeResponse(error);
    }
    throw error;
  }

  return await app.fetch(bounded);
};

export const createDefaultMcpFetch = (): McpFetch => createBoundedMcpFetch(createDefaultMcpApp());
