import assert from "node:assert/strict";
import test from "node:test";
import { createPresignedObjectTransfer } from "./objects.js";

/** Far enough out that the attempt timeout never decides a test. */
const deadline = (): number => Date.now() + 60_000;

type Attempt = () => Promise<Response>;

/**
 * Count what the retry loop actually attempts.
 *
 * The transfer's only I/O is `fetch`, so replacing it is the whole seam, and
 * the attempt count is the thing worth asserting: it is what separates a
 * transient failure the next attempt fixes from one that burns the
 * invocation's budget on an outcome no retry can change.
 */
const countAttempts = async (attempt: Attempt): Promise<number> => {
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    attempts += 1;
    return attempt();
  }) as typeof fetch;
  try {
    await createPresignedObjectTransfer(deadline()).readObject("https://objects.example/x");
  } catch {
    // The failure itself is asserted by the caller through the attempt count.
  } finally {
    globalThis.fetch = realFetch;
  }

  return attempts;
};

const raising = (error: unknown): Attempt => (): Promise<Response> => Promise.reject(error);

const answering = (status: number, body = ""): Attempt =>
  (): Promise<Response> => Promise.resolve(new Response(body, { status }));

// A 50 MB read spends almost all of its time receiving a body, so a socket
// closing part way through it is the dominant transient failure of this
// sandbox's largest reads - and undici reports it with a different message from
// a connect failure, which is why matching the message missed it entirely and
// retried it zero times. Measured on Node 24.19: `TypeError: terminated` with
// cause `SocketError: other side closed`.
test("a socket closing part way through a body is retried like any other transport failure", async (): Promise<void> => {
  assert.equal(
    await countAttempts(raising(new TypeError("terminated", { cause: new Error("other side closed") }))),
    3,
  );
  assert.equal(
    await countAttempts(raising(new TypeError("fetch failed", { cause: new Error("ENOTFOUND") }))),
    3,
  );
});

// What the narrowing is for: a bug in this workspace must not spend three
// attempts and two delays of the invocation's budget. undici always attaches
// the underlying socket, DNS or TLS error as a cause; a TypeError from reading
// a property of undefined has none, and that is the distinction drawn.
test("a programming error is attempted once", async (): Promise<void> => {
  assert.equal(await countAttempts(raising(new TypeError("x is not a function"))), 1);
  assert.equal(await countAttempts(raising(new RangeError("out of range"))), 1);
});

test("a status decides whether an answered request is attempted again", async (): Promise<void> => {
  // An expired signature answers 403, and no number of attempts re-signs it.
  assert.equal(await countAttempts(answering(403)), 1);
  assert.equal(await countAttempts(answering(404)), 1);
  // A fault on the storage side, and the two statuses that ask to be retried.
  assert.equal(await countAttempts(answering(500)), 3);
  assert.equal(await countAttempts(answering(503)), 3);
  assert.equal(await countAttempts(answering(429)), 3);
  assert.equal(await countAttempts(answering(408)), 3);
});

/** The message a failed read carries, which becomes a model-visible note. */
const failureMessage = async (status: number, body: string): Promise<string> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(body, { status })) as typeof fetch;
  try {
    await createPresignedObjectTransfer(deadline()).readObject("https://objects.example/x");
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    globalThis.fetch = realFetch;
  }
};

// The quoted body ends up in a /work note and from there in model-visible
// stderr, so it is a storage response on its way into a chat. The length cap is
// a backstop and only that: that it happens to cut before S3's
// <AWSAccessKeyId> is an artefact of S3 putting a long <Message> first, so the
// identifiers are removed by shape rather than by word order.
test("a quoted error body carries no credential, whatever its shape", async (): Promise<void> => {
  const shortDenial = await failureMessage(
    403,
    "<Error><Code>AccessDenied</Code><AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId></Error>",
  );
  // Short enough to fit inside the cap whole, which is why the cap is not the
  // thing protecting this.
  assert.ok(shortDenial.length < 200, shortDenial);
  assert.doesNotMatch(shortDenial, /AKIA/);
  assert.match(shortDenial, /AccessDenied/);

  const credentialQuery = await failureMessage(
    403,
    '{"error":"denied","credential":"ASIAY34FZKBOKMUTVV7A/20261010/eu-central-1/s3/aws4_request"}',
  );
  assert.doesNotMatch(credentialQuery, /ASIAY34FZKBOKMUTVV7A/);
  assert.match(credentialQuery, /\[redacted\]/);

  const signatureFailure = await failureMessage(
    403,
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>SignatureDoesNotMatch</Code>'
      + "<Message>The request signature we calculated does not match the signature you provided.</Message>"
      + "<AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId>"
      + "<StringToSign>AWS4-HMAC-SHA256\n20261010T000000Z\nabc</StringToSign></Error>",
  );
  assert.doesNotMatch(signatureFailure, /AKIA/);
  // One line, because the message becomes one line of stderr and S3 answers
  // with XML that has newlines of its own.
  assert.doesNotMatch(signatureFailure, /\n/);

  // A body with nothing to hide is quoted as it is, because the <Code> is the
  // part worth reading.
  const missing = await failureMessage(
    404,
    "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>",
  );
  assert.match(missing, /NoSuchKey/);
  assert.doesNotMatch(missing, /redacted/);
});
