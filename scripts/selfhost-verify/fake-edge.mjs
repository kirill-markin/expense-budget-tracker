#!/usr/bin/env node
/**
 * A stand-in for the edge proxy that docs/self-hosting.md puts in front of the
 * self-host stack. It exists so the whole AUTH_MODE=proxy_jwt path can be run
 * on one machine with Docker and no cloud account.
 *
 * What it reproduces, and nothing more:
 *   - it terminates https for the four hostnames the guide requires and
 *     forwards to the loopback ports compose.selfhost.yml publishes, keeping
 *     the original Host header, plus ECHO_HOST, which is the harness's own
 *     upstream and belongs to no deployment;
 *   - it mints an RS256 JWT for one fixed test identity and sets it on the
 *     header named by AUTH_PROXY_JWT_HEADER, the way Cloudflare Access does;
 *   - it serves the matching JWKS document on its own port, so
 *     AUTH_PROXY_JWKS_URL has something to verify against;
 *   - it applies the bypass list and the must-stay-behind list from
 *     docs/self-hosting.md to the two hosts the Access application covers, so
 *     those lists are exercised;
 *   - it deletes any inbound value of the identity header before it decides
 *     anything, so a header forged by the client can never reach a container.
 *
 * It is not Cloudflare Access: the header name, the JWKS URL shape and the
 * claim names are configuration here, and this script proves the contract the
 * containers verify, not Cloudflare's own naming.
 *
 * Dependencies: Node's standard library, plus the openssl binary, used once at
 * startup to issue the local CA and the edge certificate. Node can generate
 * key pairs but cannot issue an X.509 certificate.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { resolve } from "node:path";

const CERTIFICATE_DAYS = "2";

/** Reads a required setting, so a typo stops the edge instead of a container. */
const readRequired = (env, name) => {
  const value = (env[name] ?? "").trim();
  if (value === "") {
    throw new Error(`${name} must be set to a non-empty value for the fake edge`);
  }
  return value;
};

const readNumber = (env, name, fallback) => {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return parsed;
};

const readRequiredNumber = (env, name) => {
  const parsed = Number(readRequired(env, name));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${env[name]}"`);
  }
  return parsed;
};

export const readEdgeConfig = (env) => ({
  stateDir: resolve(readRequired(env, "EDGE_STATE_DIR")),
  appHost: readRequired(env, "APP_HOST"),
  authHost: readRequired(env, "AUTH_HOST"),
  apiHost: readRequired(env, "API_HOST"),
  mcpHost: readRequired(env, "MCP_HOST"),
  // The harness's own echo upstream. It is not part of any deployment: it
  // exists so the header strip below can be observed on a host the edge mints
  // nothing for. See scripts/selfhost-verify/verify.mjs.
  echoHost: readRequired(env, "ECHO_HOST"),
  echoPort: readRequiredNumber(env, "EDGE_ECHO_PORT"),
  identityHeader: readRequired(env, "AUTH_PROXY_JWT_HEADER").toLowerCase(),
  jwksUrl: readRequired(env, "AUTH_PROXY_JWKS_URL"),
  issuer: readRequired(env, "AUTH_PROXY_JWT_ISSUER"),
  audience: readRequired(env, "AUTH_PROXY_JWT_AUDIENCE_APP"),
  subject: readRequired(env, "EDGE_SUBJECT"),
  email: readRequired(env, "EDGE_EMAIL"),
  edgePort: readNumber(env, "EDGE_PORT", 8443),
  jwksPort: readNumber(env, "EDGE_JWKS_PORT", 8444),
  upstreamAddress: (env.EDGE_UPSTREAM_ADDRESS ?? "127.0.0.1").trim(),
});

/**
 * docs/self-hosting.md, "What must bypass the edge". Step 1 of the Cloudflare
 * Access section puts APP_HOST and AUTH_HOST in one Access application, so the
 * bypass list only ever applies to those two hosts.
 *
 * The guide's `/mcp` and `/.well-known/oauth-protected-resource/*` rows are
 * not listed here: MCP_HOST and API_HOST are outside the Access application
 * entirely, so every path on them is already forwarded without a token and a
 * per-path bypass for them could never be consulted. ECHO_HOST is deliberately
 * left out of the set for the same reason, so every path on it is bypassed and
 * carries the same "the strip is the only defence" shape as MCP_HOST.
 */
const buildRoutingPolicy = (config) => {
  const accessApplicationHosts = new Set([config.appHost, config.authHost]);
  const bypassedPaths = new Map([
    [config.authHost, ["/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token"]],
  ]);
  return { accessApplicationHosts, bypassedPaths };
};

const matchesBypassedPath = (paths, pathname) =>
  paths.some((candidate) =>
    candidate.endsWith("/") ? pathname.startsWith(candidate) : pathname === candidate);

/**
 * True when the edge must authenticate the request and mint a token for it.
 * Everything else is forwarded with no identity at all.
 */
export const isBehindAccess = (policy, host, pathname) => {
  if (!policy.accessApplicationHosts.has(host)) return false;
  const paths = policy.bypassedPaths.get(host) ?? [];
  return !matchesBypassedPath(paths, pathname);
};

const upstreamPortByHost = (config) => new Map([
  [config.appHost, 3000],
  [config.authHost, 8081],
  [config.mcpHost, 8082],
  [config.apiHost, 8083],
  [config.echoHost, config.echoPort],
]);

const base64url = (input) => Buffer.from(input).toString("base64url");

/** Mints the RS256 token the containers verify against the JWKS below. */
const mintIdentityToken = (signingKey, config, { subject, email }) => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: signingKey.kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: config.issuer,
    aud: config.audience,
    sub: subject,
    email,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), signingKey.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
};

const createSigningKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const thumbprint = createHash("sha256")
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest("base64url");
  return {
    privateKey,
    kid: thumbprint,
    jwks: { keys: [{ ...jwk, kid: thumbprint, alg: "RS256", use: "sig" }] },
  };
};

const runOpenssl = (args, cwd) => {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
};

/**
 * Issues a local CA and one leaf certificate covering every hostname the edge
 * answers on, including host.docker.internal: the containers fetch the JWKS
 * from the host through that name.
 */
const ensureTlsMaterial = (config) => {
  mkdirSync(config.stateDir, { recursive: true });
  const caCertPath = resolve(config.stateDir, "edge-ca.pem");
  const caKeyPath = resolve(config.stateDir, "edge-ca-key.pem");
  const certPath = resolve(config.stateDir, "edge-cert.pem");
  const keyPath = resolve(config.stateDir, "edge-key.pem");
  if (existsSync(caCertPath) && existsSync(certPath) && existsSync(keyPath)) {
    return { caCertPath, certPath, keyPath };
  }

  const subjectAltName = [
    config.appHost, config.authHost, config.apiHost, config.mcpHost, config.echoHost,
    "host.docker.internal", "localhost",
  ].map((host) => `DNS:${host}`).concat(["IP:127.0.0.1"]).join(",");
  const extPath = resolve(config.stateDir, "edge-cert.ext");
  writeFileSync(extPath, [
    `subjectAltName=${subjectAltName}`,
    "basicConstraints=CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"));

  runOpenssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKeyPath, "-out", caCertPath, "-days", CERTIFICATE_DAYS,
    "-subj", "/CN=selfhost-verify local edge CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], config.stateDir);
  const csrPath = resolve(config.stateDir, "edge.csr");
  runOpenssl([
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", csrPath,
    "-subj", "/CN=selfhost-verify edge",
  ], config.stateDir);
  runOpenssl([
    "x509", "-req", "-in", csrPath,
    "-CA", caCertPath, "-CAkey", caKeyPath, "-CAcreateserial",
    "-out", certPath, "-days", CERTIFICATE_DAYS, "-extfile", extPath,
  ], config.stateDir);
  return { caCertPath, certPath, keyPath };
};

const sendPlainText = (response, status, body) => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const startJwksServer = (config, tls, signingKey) => {
  const jwksPath = new URL(config.jwksUrl).pathname;
  const body = JSON.stringify(signingKey.jwks);
  const server = createServer({
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    ca: readFileSync(tls.caCertPath),
  }, (request, response) => {
    if ((request.url ?? "") !== jwksPath) {
      sendPlainText(response, 404, `The fake edge serves its JWKS at ${jwksPath} only`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(body);
  });
  return new Promise((resolvePromise) => {
    server.listen(config.jwksPort, "0.0.0.0", () => resolvePromise(server));
  });
};

const startProxyServer = (config, tls, signingKey) => {
  const policy = buildRoutingPolicy(config);
  const ports = upstreamPortByHost(config);
  const server = createServer({
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
    ca: readFileSync(tls.caCertPath),
  }, (request, response) => {
    const host = (request.headers.host ?? "").split(":")[0].toLowerCase();
    const port = ports.get(host);
    if (port === undefined) {
      sendPlainText(response, 421, `The fake edge serves no host named "${host}"`);
      return;
    }

    const headers = { ...request.headers };
    // Unconditional, and before any routing decision: a client that forges the
    // identity header must never have it reach a container.
    delete headers[config.identityHeader];
    headers.host = host;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-host"] = host;

    const pathname = new URL(request.url ?? "/", `https://${host}`).pathname;
    if (isBehindAccess(policy, host, pathname)) {
      headers[config.identityHeader] = mintIdentityToken(signingKey, config, config);
    }

    const upstream = httpRequest({
      host: config.upstreamAddress,
      port,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!response.headersSent) sendPlainText(response, 502, `Upstream error: ${error.message}`);
      else response.destroy();
      request.destroy();
    });
    // Piped, never buffered: the payload-limit checks send bodies that the
    // container must refuse, and the edge must not become the limit.
    request.pipe(upstream);
    request.on("error", () => upstream.destroy());
  });
  return new Promise((resolvePromise) => {
    server.listen(config.edgePort, "127.0.0.1", () => resolvePromise(server));
  });
};

const main = async () => {
  const config = readEdgeConfig(process.env);
  const tls = ensureTlsMaterial(config);
  const signingKey = createSigningKey();
  await startJwksServer(config, tls, signingKey);
  await startProxyServer(config, tls, signingKey);
  const descriptor = {
    edgePort: config.edgePort,
    jwksPort: config.jwksPort,
    jwksUrl: config.jwksUrl,
    caCertPath: tls.caCertPath,
    identityHeader: config.identityHeader,
    issuer: config.issuer,
    audience: config.audience,
    subject: config.subject,
    email: config.email,
    kid: signingKey.kid,
  };
  writeFileSync(resolve(config.stateDir, "edge.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  // A forged token the verifier must reject on its own merits is not the point
  // of check 2; the point is that the edge deletes the header. This one is
  // signed by the edge's own key with a different subject, which is the
  // strongest forgery a client could ever present.
  writeFileSync(
    resolve(config.stateDir, "forged-token.txt"),
    mintIdentityToken(signingKey, config, {
      subject: `${config.subject}-forged`,
      email: `forged-${config.email}`,
    }),
  );
  process.stdout.write(`fake edge ready on https://127.0.0.1:${config.edgePort} (JWKS on :${config.jwksPort})\n`);
};

await main();
