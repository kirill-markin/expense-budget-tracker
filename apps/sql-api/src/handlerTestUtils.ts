import type { APIGatewayProxyEvent } from "aws-lambda";
import type { QueryResult } from "pg";

export const createQueryResult = (rows: ReadonlyArray<unknown>): QueryResult =>
  ({
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  }) as QueryResult;

export const createEvent = (
  overrides: Partial<APIGatewayProxyEvent>,
): APIGatewayProxyEvent => ({
  body: null,
  headers: { Host: "api.example.com" },
  multiValueHeaders: {},
  httpMethod: "GET",
  isBase64Encoded: false,
  path: "/",
  pathParameters: null,
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  resource: "/",
  requestContext: {
    accountId: "123456789012",
    apiId: "api-id",
    authorizer: undefined,
    protocol: "HTTP/1.1",
    httpMethod: "GET",
    identity: {} as APIGatewayProxyEvent["requestContext"]["identity"],
    path: "/",
    stage: "v1",
    requestId: "request-id",
    requestTimeEpoch: 0,
    resourceId: "resource-id",
    resourcePath: "/",
  },
  ...overrides,
});

export const createAuthenticatedEvent = (
  overrides: Partial<APIGatewayProxyEvent>,
): APIGatewayProxyEvent => createEvent({
  requestContext: {
    ...createEvent({}).requestContext,
    authorizer: {
      userId: "user-1",
      email: "user@example.com",
      connectionId: "connection-1",
      label: "codex-desktop",
      createdAt: "2026-03-10T00:00:00.000Z",
      lastUsedAt: "",
    },
  },
  ...overrides,
});
