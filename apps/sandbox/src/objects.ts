/**
 * The sandbox's only outbound I/O: the pre-signed URLs of this invocation.
 *
 * The execution role grants nothing but its own log stream, so a URL that
 * expired or was never minted simply fails here; there is no credential the
 * sandbox could fall back to. Every transfer stops at the host the URL was
 * validated against, redirects included. Callers take the transfer as a port,
 * so the filesystems and the /work diff stay testable without the network.
 */
import { createHash } from "node:crypto";

const TRANSFER_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

/**
 * Ceiling on one attempt. undici's own header and body timeouts are 300 s,
 * longer than the whole Lambda, so without this a single stalled connection
 * consumes the invocation and returns nothing to the caller.
 */
const MAX_ATTEMPT_TIMEOUT_MS = 20_000;

/** Statuses worth another attempt; a 403 from an expired signature is not. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/** What the filesystems and the /work diff are allowed to do to object storage. */
export type SandboxObjectTransfer = Readonly<{
  readObject: (getUrl: string) => Promise<Uint8Array>;
  writeObject: (putUrl: string, mediaType: string, content: Uint8Array) => Promise<void>;
}>;

type SandboxLogEvent = Readonly<{
  action: "object_get_retry" | "object_put_retry";
  attempt: number;
  attempts: number;
  status: number | null;
  error: string;
}>;

const log = (event: SandboxLogEvent): void => {
  process.stdout.write(`${JSON.stringify({ domain: "chat_sandbox", ...event })}\n`);
};

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Characters of a failed transfer's body a message may quote.
 *
 * The message becomes a /work note and from there model-visible stderr, so the
 * body is a response from object storage on its way into a chat. S3 answers
 * SignatureDoesNotMatch with the canonical request it computed, which repeats
 * the object key, the signed headers and the access key id in
 * `<AWSAccessKeyId>`; its `<Message>` element alone is longer than this cap, so
 * the cut lands inside the human-readable part and nothing after it can be
 * reached. What is left is the `<Code>`, which is the part worth reading.
 */
const MAX_ERROR_BODY_CHARS = 120;

/**
 * Parts of an error body that carry a credential rather than a reason.
 *
 * The cap above is a length backstop and only that. That it happens to cut
 * before S3's `<AWSAccessKeyId>` holds because S3 puts a long `<Message>` in
 * front of it, which is an ordering artefact and not a guarantee: a body
 * shaped `<Error><Code>AccessDenied</Code><AWSAccessKeyId>...` is 93 characters
 * to the key id and would fit inside the cap whole. Real S3 does not emit that
 * shape, so this is not a live leak, but the guarantee should not rest on
 * another service's choice of word order.
 *
 * Both of these are removable by shape, with no XML parsing: an AWS unique id
 * is a fixed-length uppercase token from a known set of prefixes, wherever it
 * appears - a body element, or the `X-Amz-Credential` of a quoted canonical
 * request - and the signature debug elements that repeat the whole signed
 * request are named.
 */
const REDACTED_BODY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:ABIA|ACCA|AGPA|AIDA|AIPA|AKIA|ANPA|ANVA|APKA|AROA|ASCA|ASIA)[A-Z0-9]{16}\b/g,
  /<(StringToSign|StringToSignBytes|CanonicalRequest|AWSAccessKeyId)>[^]*?<\/\1>/g,
];

const describeResponseBody = async (response: Response): Promise<string> => {
  // Collapsed to one line as well as capped: the message ends up as one note
  // among the lines of stderr, and S3 answers with XML that has its own.
  const body = REDACTED_BODY_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    (await response.text()).replace(/\s+/g, " ").trim(),
  );

  return body.length <= MAX_ERROR_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_ERROR_BODY_CHARS)}[body truncated to ${String(MAX_ERROR_BODY_CHARS)} characters]`;
};

/**
 * A pre-signed transfer that reached object storage and was answered badly.
 *
 * Exported because it is the shape this module's `readObject` port rejects
 * with, and `classifyObjectReadFailure` below is what reads it: a caller
 * implementing SandboxObjectTransfer has to be able to produce the same thing.
 */
export class ObjectTransferError extends Error {
  public readonly status: number | null;

  public constructor(message: string, status: number | null) {
    super(message);
    this.name = "ObjectTransferError";
    this.status = status;
  }
}

/** The bytes arrived and are not the object the request described. */
export class ObjectContentMismatchError extends Error {
  public readonly mismatch: "size" | "digest";

  public constructor(message: string, mismatch: "size" | "digest") {
    super(message);
    this.name = "ObjectContentMismatchError";
    this.mismatch = mismatch;
  }
}

/**
 * How a failed HTTPS attempt itself arrives, as opposed to a bug above it.
 *
 * Measured on Node 24.19, one case per stage of a transfer:
 *   - socket closed before any headers: `TypeError: fetch failed`, cause
 *     `SocketError: other side closed (UND_ERR_SOCKET)`
 *   - socket closed part way through the body: `TypeError: terminated`, same
 *     cause - a different message for the same failure, and the one a 50 MB
 *     read is exposed to for almost all of its duration
 *   - connect refused: `TypeError: fetch failed`, cause `Error: bad port`
 *   - DNS failure: `TypeError: fetch failed`, cause `Error: getaddrinfo ENOTFOUND`
 *   - the attempt's own AbortSignal.timeout: `DOMException` named TimeoutError,
 *     with no cause
 *
 * So the message is not the signal and matching it missed the body-transfer
 * case entirely. What every one of these has in common is a TypeError carrying
 * the underlying socket, DNS or TLS error as its `cause`, while a programming
 * error of this workspace's own - a TypeError raised by reading a property of
 * undefined - has none. That is the distinction worth drawing: anything else
 * from an attempt would otherwise spend three attempts and two delays of the
 * invocation's budget on an outcome no retry can change.
 */
const isTransportFailure = (error: unknown): boolean =>
  (error instanceof TypeError && error.cause !== undefined)
  || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));

/**
 * Why a pre-signed read did not produce the object the request described.
 *
 * The kinds are separated by what the next step is, not by what went wrong
 * technically: `unreachable` is worth another command, `denied` is worth
 * another tool call that mints fresh URLs, and the two mismatches are worth
 * neither, because the object and the row the session read it from disagree.
 */
export type ObjectReadFailure =
  | "denied"
  | "unreachable"
  | "size_mismatch"
  | "digest_mismatch"
  | "unknown";

export const classifyObjectReadFailure = (error: unknown): ObjectReadFailure => {
  if (error instanceof ObjectContentMismatchError) {
    return error.mismatch === "size" ? "size_mismatch" : "digest_mismatch";
  }
  if (error instanceof ObjectTransferError) {
    // A status means object storage answered and refused; no status means the
    // transfer layer raised without one, which is the same as no answer.
    return error.status === null ? "unreachable" : "denied";
  }

  // `unknown` is a named case rather than a fallback: the invocation deadline
  // and anything this workspace raised itself land here, and the note that
  // reports it quotes the error instead of guessing a next step.
  return isTransportFailure(error) ? "unreachable" : "unknown";
};

const isRetryable = (error: unknown): boolean => {
  if (error instanceof ObjectTransferError) {
    // A statusless transfer error has no answer to judge, which is the same
    // position a transport failure leaves this in, so it is retried: that also
    // keeps it in step with `classifyObjectReadFailure` below, which calls it
    // `unreachable`, and with the note that kind renders, which tells the model
    // the read was attempted three times.
    return error.status === null
      || error.status >= 500
      || RETRYABLE_STATUSES.has(error.status);
  }

  return isTransportFailure(error);
};

const attemptTimeoutMs = (deadlineEpochMs: number): number => {
  const remainingMs = deadlineEpochMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(
      `Pre-signed transfer budget is exhausted: the invocation deadline passed ${String(-remainingMs)} ms ago`,
    );
  }

  return Math.min(remainingMs, MAX_ATTEMPT_TIMEOUT_MS);
};

/**
 * Retry the pre-signed transfer, then raise the last failure.
 *
 * A pre-signed URL is a plain HTTPS request with no SDK retry layer behind it,
 * and object storage answers a transient 5xx or a dropped socket often enough
 * that a single attempt would surface as a failed chat command.
 */
const transferWithRetries = async <T>(
  action: SandboxLogEvent["action"],
  deadlineEpochMs: number,
  attemptTransfer: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSFER_ATTEMPTS; attempt += 1) {
    const signal = AbortSignal.timeout(attemptTimeoutMs(deadlineEpochMs));
    try {
      return await attemptTransfer(signal);
    } catch (error) {
      lastError = error;
      log({
        action,
        attempt,
        attempts: TRANSFER_ATTEMPTS,
        status: error instanceof ObjectTransferError ? error.status : null,
        error: describeError(error),
      });
      if (!isRetryable(error)) {
        break;
      }
      if (attempt < TRANSFER_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError;
};

/**
 * Refuse a redirect instead of following it.
 *
 * The host allowlist in contract.ts validates the URL string, which binds the
 * first hop only: with the default `redirect: "follow"` undici would carry the
 * GET - or, on a 307 or 308, the PUT together with the /work file body - to any
 * host the response names. `redirect: "manual"` surfaces the redirect here, as
 * either a 3xx status or an opaque-redirect response, and this turns it into a
 * failed transfer so the enforced boundary is the one the allowlist states.
 */
const requireNoRedirect = (response: Response, label: string): void => {
  if (response.type !== "opaqueredirect" && (response.status < 300 || response.status >= 400)) {
    return;
  }

  throw new ObjectTransferError(
    `${label} answered with a redirect (HTTP ${String(response.status)}, response type '${response.type}'), which the sandbox does not follow: a pre-signed URL must be served by the host it was validated against`,
    response.status,
  );
};

const readPresignedObject = async (
  getUrl: string,
  deadlineEpochMs: number,
): Promise<Uint8Array> =>
  transferWithRetries("object_get_retry", deadlineEpochMs, async (signal) => {
    const response = await fetch(getUrl, { method: "GET", redirect: "manual", signal });
    requireNoRedirect(response, "Pre-signed object read");
    if (!response.ok) {
      throw new ObjectTransferError(
        `Pre-signed object read failed with HTTP ${String(response.status)}: ${await describeResponseBody(response)}`,
        response.status,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  });

const writePresignedObject = async (
  putUrl: string,
  mediaType: string,
  content: Uint8Array,
  deadlineEpochMs: number,
): Promise<void> =>
  transferWithRetries("object_put_retry", deadlineEpochMs, async (signal) => {
    const response = await fetch(putUrl, {
      method: "PUT",
      // The signature covers Content-Type, so it must repeat the value the web
      // task signed the slot with.
      headers: { "content-type": mediaType },
      body: content,
      redirect: "manual",
      signal,
    });
    requireNoRedirect(response, "Pre-signed object write");
    if (!response.ok) {
      throw new ObjectTransferError(
        `Pre-signed object write failed with HTTP ${String(response.status)}: ${await describeResponseBody(response)}`,
        response.status,
      );
    }
  });

/**
 * Bind every transfer of one invocation to the same deadline, so a stalled
 * connection cannot outlive the Lambda it reports back to.
 */
export const createPresignedObjectTransfer = (
  deadlineEpochMs: number,
): SandboxObjectTransfer => ({
  readObject: (getUrl: string) => readPresignedObject(getUrl, deadlineEpochMs),
  writeObject: (putUrl: string, mediaType: string, content: Uint8Array) =>
    writePresignedObject(putUrl, mediaType, content, deadlineEpochMs),
});

export const hashObjectContent = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/**
 * Fail a read whose bytes are not the object the request described.
 *
 * Size and digest came from the web task's database row and were already
 * reported to the script through `stat`, so a mismatch means the row and the
 * object disagree: serving the bytes anyway would hand a script content it was
 * told it is not reading.
 */
export const requireDescribedObject = (
  path: string,
  content: Uint8Array,
  expected: Readonly<{ sizeBytes: number; sha256: string }>,
): Uint8Array => {
  if (content.byteLength !== expected.sizeBytes) {
    throw new ObjectContentMismatchError(
      `Object for '${path}' is ${String(content.byteLength)} bytes, expected ${String(expected.sizeBytes)}`,
      "size",
    );
  }
  const sha256 = hashObjectContent(content);
  if (sha256 !== expected.sha256) {
    throw new ObjectContentMismatchError(
      `Object for '${path}' has sha256 ${sha256}, expected ${expected.sha256}`,
      "digest",
    );
  }

  return content;
};
