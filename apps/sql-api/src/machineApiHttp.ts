/**
 * HTTP adapter for the /v1 machine API.
 *
 * Converts an incoming Request into the API Gateway payload version 1
 * APIGatewayProxyEvent the machine API handler already consumes, and converts
 * its APIGatewayProxyResult back into a Response, so the same handler runs
 * unchanged behind API Gateway and inside an ordinary Node HTTP container.
 *
 * Authentication is the same agent ApiKey validation the Lambda authorizer
 * uses. A request without a valid key reaches the handler with an empty
 * authorizer context, so the 401 envelope is produced by the handler itself.
 *
 * Unlike API Gateway, the container is exposed directly, so it enforces the
 * shared request body ceiling itself. An unauthenticated request outside the
 * public discovery routes is answered without its body being read at all; every
 * other request is buffered up to the ceiling, whether or not its route reads a
 * body.
 */

import { randomUUID } from "node:crypto";
import type {
  APIGatewayEventIdentity,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { buildErrorEnvelope } from "@expense-budget-tracker/agent-shared";
import { validateAgentApiKeyAuthorization, type AgentApiKeyContext } from "./agentApiKeyAuth.js";
import { query } from "./db.js";
import { createMachineApiHandler } from "./machineApi.js";
import {
  DISCOVERY_PATHS,
  SELECT_WORKSPACE_PATH_PATTERN,
  SOURCE_DISCOVERY_PATHS,
  normalizeRoutePath,
} from "./machineApi/request.js";
import { json } from "./machineApi/responses.js";
import {
  MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  readBoundedRequestText,
} from "./requestBodyLimit.js";

export type MachineApiFetch = (request: Request) => Promise<Response>;

export type MachineApiHttpDependencies = Readonly<{
  handleEvent: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;
  validateAuthorization: (authorization: string) => Promise<AgentApiKeyContext | null>;
}>;

// Statuses whose Response must carry a null body.
const NULL_BODY_STATUS_CODES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

// API Gateway caller identity has no counterpart in the container runtime, and
// no machine API route reads it.
const CONTAINER_EVENT_IDENTITY: APIGatewayEventIdentity = {
  accessKey: null,
  accountId: null,
  apiKey: null,
  apiKeyId: null,
  caller: null,
  clientCert: null,
  cognitoAuthenticationProvider: null,
  cognitoAuthenticationType: null,
  cognitoIdentityId: null,
  cognitoIdentityPoolId: null,
  principalOrgId: null,
  sourceIp: "",
  user: null,
  userAgent: null,
  userArn: null,
};

const groupValues = (
  entries: ReadonlyArray<readonly [string, string]>,
): Record<string, Array<string>> => {
  const grouped: Record<string, Array<string>> = {};
  for (const [name, value] of entries) {
    const values = grouped[name];
    if (values === undefined) {
      grouped[name] = [value];
      continue;
    }
    values.push(value);
  }
  return grouped;
};

const readPathParameters = (normalizedPath: string): Record<string, string> | null => {
  const match = SELECT_WORKSPACE_PATH_PATTERN.exec(normalizedPath);
  if (match === null) {
    return null;
  }
  return { workspaceId: match.groups?.["workspaceId"] ?? "" };
};

// The routes the machine API answers without an authorizer context. Any other
// route gets a 401 from the handler, so its body is never read.
const readsBodyWithoutAuthentication = (method: string, normalizedPath: string): boolean =>
  method === "GET" && (DISCOVERY_PATHS.has(normalizedPath) || SOURCE_DISCOVERY_PATHS.has(normalizedPath));

const buildRequestBodyTooLargeResult = (error: RequestBodyTooLargeError): APIGatewayProxyResult =>
  json(
    413,
    buildErrorEnvelope(
      { maxRequestBodyBytes: error.maxBytes },
      [],
      `Send a request body of at most ${String(error.maxBytes)} bytes.`,
      "payload_too_large",
      error.message,
    ),
  );

export const createProxyEventFromRequest = async (
  request: Request,
  authenticated: AgentApiKeyContext | null,
): Promise<APIGatewayProxyEvent> => {
  const url = new URL(request.url);
  const normalizedPath = normalizeRoutePath(url.pathname);
  const headerEntries: Array<readonly [string, string]> = [...request.headers.entries()];
  const queryEntries: Array<readonly [string, string]> = [...url.searchParams.entries()];
  const body = authenticated === null && !readsBodyWithoutAuthentication(request.method, normalizedPath)
    ? ""
    : await readBoundedRequestText(request, "machine API", MAX_REQUEST_BODY_BYTES);

  const event: APIGatewayProxyEvent = {
    body: body === "" ? null : body,
    headers: Object.fromEntries(headerEntries),
    multiValueHeaders: groupValues(headerEntries),
    httpMethod: request.method,
    isBase64Encoded: false,
    path: url.pathname,
    pathParameters: null,
    queryStringParameters: queryEntries.length === 0 ? null : Object.fromEntries(queryEntries),
    multiValueQueryStringParameters: queryEntries.length === 0 ? null : groupValues(queryEntries),
    stageVariables: null,
    resource: url.pathname,
    requestContext: {
      accountId: "",
      apiId: "",
      authorizer: authenticated === null ? {} : { ...authenticated },
      protocol: "HTTP/1.1",
      httpMethod: request.method,
      identity: CONTAINER_EVENT_IDENTITY,
      path: url.pathname,
      stage: "v1",
      requestId: randomUUID(),
      requestTimeEpoch: Date.now(),
      resourceId: "",
      resourcePath: url.pathname,
    },
  };

  return { ...event, pathParameters: readPathParameters(normalizedPath) };
};

export const createResponseFromProxyResult = (result: APIGatewayProxyResult): Response => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    headers.set(name, String(value));
  }
  for (const [name, values] of Object.entries(result.multiValueHeaders ?? {})) {
    for (const value of values) {
      headers.append(name, String(value));
    }
  }

  if (NULL_BODY_STATUS_CODES.has(result.statusCode)) {
    return new Response(null, { status: result.statusCode, headers });
  }

  const body = result.isBase64Encoded === true ? Buffer.from(result.body, "base64") : result.body;
  return new Response(body, { status: result.statusCode, headers });
};

export const createMachineApiFetch = (
  dependencies: MachineApiHttpDependencies,
): MachineApiFetch => async (request: Request): Promise<Response> => {
  const authenticated = await dependencies.validateAuthorization(request.headers.get("authorization") ?? "");

  let event: APIGatewayProxyEvent;
  try {
    event = await createProxyEventFromRequest(request, authenticated);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return createResponseFromProxyResult(buildRequestBodyTooLargeResult(error));
    }
    throw error;
  }

  return createResponseFromProxyResult(await dependencies.handleEvent(event));
};

export const createDefaultMachineApiFetch = (): MachineApiFetch => createMachineApiFetch({
  handleEvent: createMachineApiHandler({}),
  validateAuthorization: (authorization) => validateAgentApiKeyAuthorization(authorization, { query }),
});
