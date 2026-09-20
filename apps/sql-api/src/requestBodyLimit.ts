/**
 * Request body ceiling shared by the directly exposed container surfaces.
 *
 * API Gateway rejected any payload above its 10 MB hard cap before the
 * integration ran. The containers keep the same ceiling, so a legitimate client
 * sees identical behavior, and an oversized body is refused while it streams
 * instead of being buffered whole.
 */

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// Named in the error message, so each surface keeps the wording its own
// clients already see.
export type RequestBodySurface = "machine API" | "MCP";

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(surface: RequestBodySurface, maxBytes: number) {
    super(`Request body exceeds the ${surface} limit of ${String(maxBytes)} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

const exceedsDeclaredContentLength = (request: Request, maxBytes: number): boolean => {
  // Node's HTTP parser rejects a malformed Content-Length before the handler
  // runs; the streaming guard below is the authoritative limit in every case,
  // and this header check only avoids reading a body already declared too big.
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > maxBytes;
};

const readBoundedRequestChunks = async (
  request: Request,
  surface: RequestBodySurface,
  maxBytes: number,
): Promise<Array<Uint8Array>> => {
  if (exceedsDeclaredContentLength(request, maxBytes)) {
    throw new RequestBodyTooLargeError(surface, maxBytes);
  }

  const stream = request.body;
  if (stream === null) {
    return [];
  }

  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let readBytes = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    readBytes += chunk.value.byteLength;
    if (readBytes > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(surface, maxBytes);
    }

    chunks.push(chunk.value);
  }

  return chunks;
};

// For a surface that replays the body as bytes: nothing is decoded, so a
// non-UTF-8 payload survives unchanged and no re-encoding copy is made.
export const readBoundedRequestBytes = async (
  request: Request,
  surface: RequestBodySurface,
  maxBytes: number,
): Promise<Uint8Array> => Buffer.concat(await readBoundedRequestChunks(request, surface, maxBytes));

// For a surface that consumes the body as text, such as the API Gateway proxy
// event the machine API handler reads.
export const readBoundedRequestText = async (
  request: Request,
  surface: RequestBodySurface,
  maxBytes: number,
): Promise<string> =>
  Buffer.concat(await readBoundedRequestChunks(request, surface, maxBytes)).toString("utf8");
