/**
 * Telling a fault of this sandbox from a property of the source it was handed.
 *
 * Its own module because both document operations need the same answer and
 * neither owns it, which is the reason conversionLibrary.ts is its own module
 * too: `prepare` asks it in three places and `pdf_page` in two, and the two
 * surfaces disagreeing about what a TypeError means is exactly the divergence
 * that put a transport failure on an operator's pager.
 *
 * The distinction is what the answer channel is for. A fault here must be
 * raised - a Lambda FunctionError, which pages and is the only channel a build
 * or wiring defect has - and a property of the source must be answered, because
 * the caller records an answer against the user's file and never retries it.
 * Getting it the wrong way round is costly in both directions: a defect
 * answered as the file's fault marks real uploads permanently unconvertible
 * with nothing anywhere saying the sandbox is broken, and a transient outage
 * raised as a defect pages an operator for something no fix addresses.
 */
import { ConversionLibraryError } from "./conversionLibrary.js";
import { isObjectTransportFailure } from "./objects.js";

/**
 * A failure that is about neither this source nor any other, so it must not be
 * answered at all.
 *
 * Two kinds, and one predicate because every phase below has to treat them the
 * same way. A library this build cannot load is every source of its format, for
 * as long as that bundle is deployed. A TypeError, a ReferenceError or a
 * RangeError is this repository's own code being wrong: nothing raises one
 * deliberately, so one arriving means a property was read off undefined or a
 * value was outside what the code that produced it allows.
 *
 * Named classes rather than "anything the parsers did not say": a parser handed
 * a corrupt container throws its own message as a bare `Error`, and that IS the
 * source.
 *
 * The transport exemption is the whole reason this is not just the three
 * classes. Measured on Node 24.19, every way a pre-signed HTTPS transfer can
 * fail below the status line arrives as a TypeError - `fetch failed` for a
 * socket closed before headers, for a refused connect and for a DNS failure,
 * and `terminated` for a socket closed part way through the body, which is the
 * one a 50 MB read is exposed to for almost all of its duration. Without this
 * clause all four were raised: driven end to end against a server that drops
 * the socket, `prepare` produced a FunctionError and no response at all, while
 * an HTTP 503 through the same code answered `unavailable`. So the retryable
 * arm was dead for the dominant transient failure. objects.ts owns the test
 * that tells the two apart - the socket, DNS or TLS error carried as `cause`,
 * which a bug of this workspace's own never has - and it is imported rather
 * than copied, because a second copy would be the half that drifts.
 */
export const isSandboxDefect = (error: unknown): boolean =>
  (error instanceof ConversionLibraryError
    || error instanceof TypeError
    || error instanceof ReferenceError
    || error instanceof RangeError)
  && !isObjectTransportFailure(error);
