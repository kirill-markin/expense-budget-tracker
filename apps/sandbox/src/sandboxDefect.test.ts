import assert from "node:assert/strict";
import test from "node:test";
import { ConversionLibraryError } from "./conversionLibrary.js";
import { ObjectContentMismatchError, ObjectTransferError } from "./objects.js";
import { isSandboxDefect } from "./sandboxDefect.js";

/**
 * The predicate on its own, over the population that reaches it.
 *
 * Here rather than only through prepareSource and extractPdfPage, because this
 * one function decides between two opposite channels for both of them - a
 * raised FunctionError that pages an operator, and an answer the caller records
 * against the user's file - and the boundary it draws is not visible from
 * either call site. The cases below are the measured ones, which is the whole
 * reason the boundary is where it is.
 */

/**
 * Faults of this sandbox, which must be raised.
 *
 * A library this build cannot load is every source of its format for as long as
 * the bundle is deployed. The three native classes are this repository's own
 * code being wrong: none is raised deliberately anywhere, so one arriving means
 * a property was read off undefined or a value was outside what produced it.
 *
 * Every TypeError here has no `cause`, and that is the discriminator rather
 * than a detail of the fixtures: it is the only thing separating these from the
 * transport failures below, which are TypeErrors too.
 */
const SANDBOX_FAULTS: ReadonlyArray<Readonly<{ label: string; error: unknown }>> = [
  {
    label: "a parser this build cannot load",
    error: new ConversionLibraryError("mammoth", new Error('Dynamic require of "url" is not supported')),
  },
  {
    label: "a property read off undefined",
    error: new TypeError("Cannot read properties of undefined (reading 'byteLength')"),
  },
  {
    label: "a name that is not defined",
    error: new ReferenceError("readFileSync is not defined"),
  },
  {
    label: "an argument outside its range",
    error: new RangeError("Invalid typed array length: -1"),
  },
];

for (const { label, error } of SANDBOX_FAULTS) {
  test(`${label} is a fault of this sandbox`, (): void => {
    assert.equal(isSandboxDefect(error), true);
  });
}

/**
 * Transport failures, which must not be.
 *
 * Measured on Node 24.19, one per stage of a pre-signed transfer: a socket
 * closed before any headers, a socket closed part way through the body - the
 * one a 50 MB read is exposed to for almost all of its duration - a refused
 * connect and a DNS failure. All four are TypeErrors, which is why testing the
 * class alone put every one of them on the error alarm: driven end to end, each
 * produced a FunctionError and no response at all, where an HTTP 503 through
 * the same code answered `unavailable`.
 *
 * What they have that a bug of this workspace does not is the underlying
 * socket, DNS or TLS error as `cause`, and objects.ts owns that test.
 */
const TRANSPORT_FAILURES: ReadonlyArray<Readonly<{ label: string; error: unknown }>> = [
  {
    label: "a socket closed before any headers",
    error: new TypeError("fetch failed", { cause: new Error("other side closed") }),
  },
  {
    label: "a socket closed part way through the body",
    error: new TypeError("terminated", { cause: new Error("other side closed") }),
  },
  {
    label: "a refused connect",
    error: new TypeError("fetch failed", { cause: new Error("bad port") }),
  },
  {
    label: "a DNS failure",
    error: new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }),
  },
  {
    label: "an attempt's own timeout",
    error: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  },
];

for (const { label, error } of TRANSPORT_FAILURES) {
  test(`${label} is not a fault of this sandbox`, (): void => {
    assert.equal(isSandboxDefect(error), false);
  });
}

/**
 * And what the parsers and this layer say about a document, which is neither.
 *
 * A parser handed a corrupt container throws its own message as a bare `Error`,
 * and so do this layer's own refusals, and that IS the source: answering them
 * is the point. They are listed because the predicate is written as named
 * classes precisely so these fall through it, and a predicate rewritten as
 * "anything the parsers did not say" would catch them.
 */
const SOURCE_VERDICTS: ReadonlyArray<Readonly<{ label: string; error: unknown }>> = [
  { label: "a corrupt container", error: new Error("Corrupted zip: can't find end of central directory") },
  { label: "an encrypted document", error: new Error("No password given") },
  {
    label: "storage answering a status",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 403: AccessDenied", 403),
  },
  {
    label: "bytes that are not the object described",
    error: new ObjectContentMismatchError("Object for '/files/a.pdf' is 3 bytes, expected 4", "size"),
  },
  { label: "something that is not an error at all", error: "a string nobody wrapped" },
];

for (const { label, error } of SOURCE_VERDICTS) {
  test(`${label} is not a fault of this sandbox either`, (): void => {
    assert.equal(isSandboxDefect(error), false);
  });
}
