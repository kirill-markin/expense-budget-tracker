/**
 * Typed route errors for plain-text HTTP responses.
 *
 * API routes throw ApiRouteError for expected client and route-mapped failures
 * so handlers can keep validation and response mapping consistent.
 */
import { ZodError } from "zod";

/**
 * Error type for API routes that already know which HTTP status and public
 * message must be returned to the client.
 */
export class ApiRouteError extends Error {
  public readonly status: number;
  public readonly publicMessage: string;

  public constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "ApiRouteError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/**
 * Create a 400 route error with the exact public message expected by the API client.
 */
export const createBadRequestError = (message: string): ApiRouteError =>
  new ApiRouteError(400, message);

/**
 * Create a route error for failures that should be exposed with a fixed public
 * message instead of leaking internal details.
 */
export const createInternalRouteError = (message: string): ApiRouteError =>
  new ApiRouteError(500, message);

/**
 * Convert a zod validation failure into a 400 route error using the first
 * schema-defined issue message.
 */
export const fromZodError = (error: ZodError): ApiRouteError => {
  const issue = error.issues[0];
  if (issue === undefined) {
    throw new Error("ZodError did not contain any issues");
  }
  return createBadRequestError(issue.message);
};

export const toErrorResponse = (error: ApiRouteError): Response =>
  new Response(error.publicMessage, { status: error.status });
