#!/usr/bin/env node
/**
 * End-to-end verification of the AUTH_MODE=proxy_jwt self-hosting path on one
 * machine: brings up infra/docker/compose.selfhost.yml, puts the fake edge in
 * scripts/selfhost-verify/fake-edge.mjs in front of it, and runs the ordered
 * checks below, printing one pass/fail line each and stopping on the first
 * failure.
 *
 * It changes no application code and no part of the shipped stack. It also
 * touches nothing a real self-host deployment on this machine owns: it runs in
 * its own Compose project and writes its env file under tmp/, never over
 * infra/docker/.env.selfhost.
 *
 * The fake edge's JWKS certificate is issued by a CA of its own, so the run
 * also exercises the trust extension docs/self-hosting.md gives a gateway
 * behind internal PKI: SELFHOST_EDGE_CA_DIR and NODE_EXTRA_CA_CERTS in the env
 * file below, both documented variables of the shipped stack.
 *
 * Read scripts/selfhost-verify/README.md for what each check proves.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = resolve(REPO_ROOT, "tmp", "selfhost-verify");
// Never infra/docker/.env.selfhost: docs/self-hosting.md tells the operator to
// create that file with their own passwords, and a verification run must not
// overwrite it.
const ENV_FILE = resolve(STATE_DIR, ".env.selfhost");
const COMPOSE_FILE = resolve(REPO_ROOT, "infra", "docker", "compose.selfhost.yml");
// The directory SELFHOST_EDGE_CA_DIR points the stack at. It holds the edge
// CA certificate and nothing else: the CA private key stays in STATE_DIR and
// is never mounted into a container.
const CA_DIR = resolve(STATE_DIR, "ca");
const CA_FILE_NAME = "edge-ca.pem";
const CA_MOUNT_PATH = `/etc/ssl/selfhost-ca/${CA_FILE_NAME}`;
// compose.selfhost.yml pins `name: expense-budget-tracker-selfhost`, which is
// the project a real self-hoster on this machine is running. This run must
// never adopt it: it rebuilds services and tears the project down with its
// volume.
const COMPOSE_PROJECT = "expense-budget-tracker-selfhost-verify";

const DOMAIN = "selfhost.test";
const APP_HOST = `app.${DOMAIN}`;
const AUTH_HOST = `auth.${DOMAIN}`;
const API_HOST = `api.${DOMAIN}`;
const MCP_HOST = `mcp.${DOMAIN}`;
// Not a deployment hostname. It is routed by the edge to the harness's own
// echo upstream, outside the edge's Access application, so check 2 can read
// back exactly which headers the edge forwarded. See startEchoServer.
const ECHO_HOST = `echo.${DOMAIN}`;
const EDGE_HOSTS = new Set([APP_HOST, AUTH_HOST, API_HOST, MCP_HOST, ECHO_HOST]);
const EDGE_PORT = 8443;
const EDGE_JWKS_PORT = 8444;
const IDENTITY_HEADER = "cf-access-jwt-assertion";
const SUBJECT = "selfhost-verify-subject";
const EMAIL = "selfhost-verify@example.invalid";
const FORGED_SUBJECT = `${SUBJECT}-forged`;
const OAUTH_RESOURCE = `https://${MCP_HOST}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:8765/callback";
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const PROXY_JWT_UNAUTHORIZED_MESSAGE =
  "Unauthorized: this deployment expects an upstream authentication proxy to forward a verified identity token. Sign in through the proxy and retry.";
const LOCAL_ROW_MARKER = "selfhost-verify-local-row";

const options = {
  keepUp: process.argv.includes("--keep-up"),
};

const log = (line) => process.stdout.write(`${line}\n`);

class CheckFailure extends Error {}

const expect = (condition, message) => {
  if (!condition) throw new CheckFailure(message);
};

// --------------------------------------------------------------------------
// Stack lifecycle
// --------------------------------------------------------------------------

const composeArgs = () => [
  "compose",
  "-f", COMPOSE_FILE,
  "--env-file", ENV_FILE,
  "-p", COMPOSE_PROJECT,
];

const docker = (args, { capture = false } = {}) =>
  execFileSync("docker", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });

const compose = (args, opts) => docker([...composeArgs(), ...args], opts);

/** One statement, as the `tracker` superuser, the way docs/self-hosting.md revokes access. */
const psql = (sql) =>
  compose(["exec", "-T", "postgres", "psql", "-U", "tracker", "-d", "tracker", "-At",
    "-v", "ON_ERROR_STOP=1", "-c", sql], { capture: true }).trim();

const writeEnvFile = () => {
  writeFileSync(ENV_FILE, [
    "# Written by scripts/selfhost-verify/verify.mjs into tmp/selfhost-verify/,",
    "# never over infra/docker/.env.selfhost, which belongs to the operator.",
    `APP_HOST=${APP_HOST}`,
    `AUTH_HOST=${AUTH_HOST}`,
    `API_HOST=${API_HOST}`,
    `MCP_HOST=${MCP_HOST}`,
    `COOKIE_DOMAIN=${DOMAIN}`,
    "",
    `AUTH_PROXY_JWT_HEADER=${IDENTITY_HEADER}`,
    `AUTH_PROXY_JWKS_URL=https://host.docker.internal:${String(EDGE_JWKS_PORT)}/cdn-cgi/access/certs`,
    `AUTH_PROXY_JWT_ISSUER=https://edge.${DOMAIN}`,
    "AUTH_PROXY_JWT_AUDIENCE_APP=selfhost-verify-audience",
    "AUTH_PROXY_JWT_AUDIENCE_AUTH=selfhost-verify-audience",
    "",
    "# No public CA signed the fake edge's JWKS certificate, so the stack is",
    "# given its CA the way docs/self-hosting.md gives one to a gateway behind",
    "# internal PKI. Both variables are part of compose.selfhost.yml.",
    `SELFHOST_EDGE_CA_DIR=${CA_DIR}`,
    `NODE_EXTRA_CA_CERTS=${CA_MOUNT_PATH}`,
    "",
    "POSTGRES_PASSWORD=selfhost-verify-postgres",
    "APP_DB_PASSWORD=selfhost-verify-app",
    "AUTH_DB_PASSWORD=selfhost-verify-auth",
    "WORKER_DB_PASSWORD=selfhost-verify-worker",
    "",
  ].join("\n"));
};

/**
 * Publishes the edge CA certificate, and only that certificate, into the
 * directory the env file points SELFHOST_EDGE_CA_DIR at. Copied rather than
 * mounted from STATE_DIR because that directory also holds the CA private key.
 * The containers run as a non-root user, so the directory has to be traversable
 * and the file readable by one — mkdirSync takes the process umask, which under
 * a restrictive one would leave the mount unreadable and fail check 1.
 */
const publishEdgeCa = () => {
  mkdirSync(CA_DIR, { recursive: true });
  chmodSync(CA_DIR, 0o755);
  copyFileSync(resolve(STATE_DIR, CA_FILE_NAME), resolve(CA_DIR, CA_FILE_NAME));
  chmodSync(resolve(CA_DIR, CA_FILE_NAME), 0o644);
};

const startFakeEdge = (echoPort) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("node", [resolve(REPO_ROOT, "scripts", "selfhost-verify", "fake-edge.mjs")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      EDGE_STATE_DIR: STATE_DIR,
      APP_HOST, AUTH_HOST, API_HOST, MCP_HOST, ECHO_HOST,
      EDGE_ECHO_PORT: String(echoPort),
      AUTH_PROXY_JWT_HEADER: IDENTITY_HEADER,
      AUTH_PROXY_JWKS_URL: `https://host.docker.internal:${String(EDGE_JWKS_PORT)}/cdn-cgi/access/certs`,
      AUTH_PROXY_JWT_ISSUER: `https://edge.${DOMAIN}`,
      AUTH_PROXY_JWT_AUDIENCE_APP: "selfhost-verify-audience",
      EDGE_SUBJECT: SUBJECT,
      EDGE_EMAIL: EMAIL,
      EDGE_PORT: String(EDGE_PORT),
      EDGE_JWKS_PORT: String(EDGE_JWKS_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("fake edge ready")) resolvePromise(child);
  });
  child.on("exit", (code) => rejectPromise(new Error(`fake edge exited with ${String(code)}: ${stderr}`)));
  // Without this a failure to spawn node at all becomes an uncaught exception
  // outside the try below, which would skip teardown entirely.
  child.on("error", rejectPromise);
});

/**
 * A harness-owned upstream that reflects the request it received. ECHO_HOST is
 * routed to it and sits outside the edge's Access application, exactly like
 * MCP_HOST and API_HOST, so deleting the inbound identity header is the only
 * thing between the client and this upstream — and, unlike a container, it can
 * be asked what it actually received. It listens on an ephemeral loopback port
 * and lives only for the run.
 */
const startEchoServer = () => new Promise((resolvePromise, rejectPromise) => {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers }));
  });
  server.on("error", rejectPromise);
  server.listen(0, "127.0.0.1", () => resolvePromise(server));
});

const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });

const waitForStack = async () => {
  const probes = [
    { name: "web", url: "http://127.0.0.1:3000/api/live", requireOk: true },
    { name: "auth", url: "http://127.0.0.1:8081/health", requireOk: true },
    { name: "mcp", url: "http://127.0.0.1:8082/.well-known/oauth-protected-resource/mcp", requireOk: true },
    // Readiness only. Whether a direct GET /v1/ answers the discovery envelope
    // rather than a 500 is exactly what check 8 exists to establish, so this
    // probe must not require it and quietly settle the question first.
    { name: "api", url: "http://127.0.0.1:8083/v1/", requireOk: false },
  ];
  const deadline = Date.now() + 180_000;
  for (const { name, url, requireOk } of probes) {
    for (;;) {
      try {
        const response = await send(url, {});
        if (!requireOk || response.status === 200) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`${name} never became ready at ${url}`);
      await sleep(1000);
    }
  }
};

// --------------------------------------------------------------------------
// HTTP, through the edge or straight at a published port
// --------------------------------------------------------------------------

let caCertificate = null;

const send = (target, { method = "GET", headers = {}, body = null } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(target);
    const throughEdge = EDGE_HOSTS.has(url.hostname);
    const requestHeaders = { ...headers };
    if (body !== null) requestHeaders["content-length"] = String(Buffer.byteLength(body));

    const transport = throughEdge || url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestOptions = throughEdge
      ? {
        host: "127.0.0.1",
        port: EDGE_PORT,
        servername: url.hostname,
        ca: [caCertificate],
        path: `${url.pathname}${url.search}`,
        method,
        // The edge routes on this, the MCP transport validates it, and it must
        // carry no port: the stack's hostnames are served on 443 in a real
        // deployment.
        headers: { ...requestHeaders, host: url.hostname },
      }
      : {
        host: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
      };

    let settled = false;
    const request = transport(requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        settled = true;
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    // The payload-limit checks are answered and the connection closed while
    // the body is still going out, so the write side fails after the response
    // has already been read. That is the expected shape of the check, not an
    // error of the run.
    request.on("socket", (socket) => socket.on("error", () => undefined));
    if (body !== null) request.write(body, () => undefined);
    request.end();
  });

const cookieJar = new Map();

const rememberCookies = (response) => {
  for (const raw of response.headers["set-cookie"] ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index > 0) cookieJar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
};

const cookieHeader = () =>
  [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

/** A browser-shaped GET: keeps cookies and follows the bootstrap redirect. */
const browserGet = async (target, extraHeaders = {}) => {
  let current = target;
  for (let hop = 0; hop < 8; hop += 1) {
    const headers = { ...extraHeaders, accept: "text/html,application/json" };
    const cookies = cookieHeader();
    if (cookies !== "") headers.cookie = cookies;
    const response = await send(current, { headers });
    rememberCookies(response);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && typeof location === "string") {
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new CheckFailure(`Too many redirects starting at ${target}`);
};

/**
 * Workspace ids only, sorted: /api/workspaces also carries names and ordering
 * that say nothing about which identity answered.
 */
const workspaceIds = (body) =>
  JSON.parse(body).map((workspace) => workspace.workspaceId).sort().join(",");

// --------------------------------------------------------------------------
// MCP and OAuth helpers
// --------------------------------------------------------------------------

const base64url = (value) => Buffer.from(value).toString("base64url");
const sha256hex = (value) => createHash("sha256").update(value).digest("hex");

const mcpCall = async (accessToken, payload, { extraBody = null } = {}) => {
  const body = extraBody ?? JSON.stringify(payload);
  const response = await send(OAUTH_RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      origin: `https://${MCP_HOST}`,
    },
    body,
  });
  return response;
};

const parseMcpResult = (response) => {
  expect(response.status === 200, `MCP responded ${String(response.status)}: ${response.body.slice(0, 400)}`);
  const parsed = JSON.parse(response.body);
  expect(parsed.error === undefined, `MCP returned a JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
};

const readToolPayload = (result) => {
  expect(Array.isArray(result?.content) && result.content.length > 0, "Tool result carried no content");
  return JSON.parse(result.content[0].text);
};

/** Dynamic client registration, at whichever base URL the caller is probing. */
const registerOAuthClient = async (baseUrl) => {
  const registration = await send(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "selfhost-verify", redirect_uris: [REDIRECT_URI] }),
  });
  expect(registration.status === 201, `Registration responded ${String(registration.status)}: ${registration.body}`);
  return JSON.parse(registration.body).client_id;
};

const createAuthorizationRequest = async (baseUrl) => {
  const clientId = await registerOAuthClient(baseUrl);
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    parameters: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "expenses:read expenses:write",
      resource: OAUTH_RESOURCE,
      state: randomBytes(16).toString("base64url"),
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    },
  };
};

const submitConsent = (parameters) => send(`https://${AUTH_HOST}/oauth/authorize`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    // The consent POST demands an Origin equal to OAUTH_ISSUER.
    origin: `https://${AUTH_HOST}`,
  },
  body: new URLSearchParams({ ...parameters, decision: "allow" }).toString(),
});

const runOAuthFlow = async () => {
  const metadata = await send(`https://${AUTH_HOST}/.well-known/oauth-authorization-server`);
  expect(metadata.status === 200, `Authorization-server metadata responded ${String(metadata.status)}`);
  const endpoints = JSON.parse(metadata.body);
  expect(endpoints.issuer === `https://${AUTH_HOST}`, `Unexpected issuer ${String(endpoints.issuer)}`);

  const { parameters, verifier } = await createAuthorizationRequest(`https://${AUTH_HOST}`);

  const query = new URLSearchParams(parameters).toString();
  const consent = await send(`https://${AUTH_HOST}/oauth/authorize?${query}`);
  expect(consent.status === 200, `Consent page responded ${String(consent.status)}: ${consent.body.slice(0, 300)}`);
  expect(consent.body.includes('name="decision"'), "Consent page carried no decision control");

  const decision = await submitConsent(parameters);
  expect(decision.status === 302, `Consent submission responded ${String(decision.status)}: ${decision.body.slice(0, 300)}`);
  const redirected = new URL(String(decision.headers.location));
  expect(redirected.searchParams.get("state") === parameters.state, "Consent redirect returned a different state");
  const code = redirected.searchParams.get("code");
  expect(typeof code === "string" && code.startsWith("ebt_ac_"), `Consent redirect carried no code: ${redirected.search}`);

  const token = await send(`https://${AUTH_HOST}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: parameters.client_id,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: OAUTH_RESOURCE,
    }).toString(),
  });
  expect(token.status === 200, `Token endpoint responded ${String(token.status)}: ${token.body}`);
  const issued = JSON.parse(token.body);
  expect(typeof issued.access_token === "string" && issued.access_token.startsWith("ebt_at_"),
    `Token endpoint issued no ebt_at_ access token: ${token.body}`);
  return issued.access_token;
};

// --------------------------------------------------------------------------
// Checks
// --------------------------------------------------------------------------

const state = { accessToken: "", workspaceId: "", apiKey: "" };

const readUserColumn = (column, userId = SUBJECT) =>
  psql(`SELECT ${column} FROM public.users WHERE user_id = '${userId}'`);

const readLastSeenEpoch = () => Number(readUserColumn("extract(epoch from last_seen_at)"));

/**
 * Mints the /v1 key the way a self-hoster has to: through the app's own
 * creation route, on the browser session the edge already authenticated.
 * Seeding the row straight into auth.agent_api_keys would exercise the
 * machine API without exercising the only path this mode has to reach it.
 */
const ensureAgentApiKey = async () => {
  if (state.apiKey !== "") return;
  const csrfToken = cookieJar.get("__Host-csrf") ?? "";
  expect(csrfToken !== "", "The browser jar carries no CSRF cookie, so no app POST can be made");
  const created = await send(`https://${APP_HOST}/api/agent-connections`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(),
      origin: `https://${APP_HOST}`,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ label: "selfhost-verify" }),
  });
  expect(created.status === 200,
    `Creating an agent API key answered ${String(created.status)}: ${created.body.slice(0, 300)}`);
  const { apiKey } = JSON.parse(created.body);
  expect(typeof apiKey === "string" && apiKey.startsWith("ebta_"),
    `The creation route returned no ebta_ key: ${created.body.slice(0, 300)}`);
  // The plaintext is returned once; what is kept is its hash.
  const storedHash = psql(`SELECT key_hash FROM auth.agent_api_keys WHERE key_id = '${apiKey.split("_")[1]}'`);
  expect(storedHash === sha256hex(apiKey.split("_")[2]),
    "The stored key_hash is not the sha256 of the issued secret");
  state.apiKey = apiKey;
};

const checks = [
  ["a web request through the edge verifies the privately issued JWKS and resolves the test identity", async () => {
    const response = await browserGet(`https://${APP_HOST}/`);
    expect(response.status === 200, `The app answered ${String(response.status)} instead of 200`);
    expect(readUserColumn("email") === EMAIL, `users.email is "${readUserColumn("email")}", expected "${EMAIL}"`);
    expect(readUserColumn("cognito_status") === "PROXY",
      `users.cognito_status is "${readUserColumn("cognito_status")}", expected "PROXY"`);
    state.workspaceId = psql(`SELECT workspace_id FROM workspace_members WHERE user_id = '${SUBJECT}' LIMIT 1`);
    expect(state.workspaceId !== "", "The provisioned identity owns no workspace");
  }],

  ["the edge strips a client-forged identity header that a container would act on", async () => {
    const forged = readFileSync(resolve(STATE_DIR, "forged-token.txt"), "utf8").trim();
    // A --keep-up stack can still carry the forged rows from an earlier run.
    // Both user_settings and workspace_members reference users(user_id) with
    // no cascade, and the positive control below writes a user_settings row,
    // so the users delete only succeeds after those two.
    psql(`DELETE FROM user_settings WHERE user_id = '${FORGED_SUBJECT}'`);
    psql(`DELETE FROM workspace_members WHERE user_id = '${FORGED_SUBJECT}'`);
    psql(`DELETE FROM public.users WHERE user_id = '${FORGED_SUBJECT}'`);

    // Behind Access the edge overwrites the header, so this pair alone cannot
    // tell an overwrite from a strip. It is here because the overwrite is
    // still worth pinning, not because it proves the strip.
    const honest = await browserGet(`https://${APP_HOST}/api/workspaces`);
    const spoofed = await browserGet(`https://${APP_HOST}/api/workspaces`, { [IDENTITY_HEADER]: forged });
    expect(spoofed.status === 200, `The spoofed request answered ${String(spoofed.status)}`);
    expect(workspaceIds(spoofed.body) === workspaceIds(honest.body),
      `The spoofed request saw workspaces [${workspaceIds(spoofed.body)}], the test identity saw [${workspaceIds(honest.body)}]`);

    // The strip itself, read back from the upstream that received the request.
    // ECHO_HOST is outside the Access application, like MCP_HOST and API_HOST,
    // so the edge mints nothing for it and deleting the inbound header is the
    // only defence. Removing that delete from fake-edge.mjs fails this leg.
    for (const probePath of ["/.well-known/oauth-authorization-server", "/mcp"]) {
      const echoed = await send(`https://${ECHO_HOST}${probePath}`, {
        headers: { [IDENTITY_HEADER]: forged, "x-selfhost-verify-probe": probePath },
      });
      expect(echoed.status === 200, `The echo upstream answered ${String(echoed.status)} on ${probePath}`);
      const seen = JSON.parse(echoed.body).headers;
      // Without these two the absence of the identity header below could just
      // mean the request never arrived, or arrived stripped of everything.
      expect(seen["x-selfhost-verify-probe"] === probePath,
        `The echo upstream never saw the probe header on ${probePath}, so an absent identity header proves nothing`);
      expect(seen.host === ECHO_HOST, `The echo upstream saw Host "${String(seen.host)}" on ${probePath}`);
      expect(seen[IDENTITY_HEADER] === undefined,
        `The edge forwarded the forged identity header to a bypassed upstream on ${probePath}: ${String(seen[IDENTITY_HEADER]).slice(0, 80)}`);
    }

    // Positive control, and the reason the two results above mean anything:
    // the very same token provisions a second account the moment it reaches a
    // container without passing the edge.
    const direct = await send("http://127.0.0.1:3000/api/workspaces/bootstrap", {
      headers: { [IDENTITY_HEADER]: forged },
    });
    expect(direct.status === 307,
      `The container answered ${String(direct.status)} to the forged token straight at its port, expected the 307 bootstrap redirect`);
    expect(psql(`SELECT count(*) FROM public.users WHERE user_id = '${FORGED_SUBJECT}'`) === "1",
      "The forged token was inert even straight at the container, so stripping it proves nothing");
  }],

  ["web and auth answer 401 to a request that bypasses the edge with no token", async () => {
    const web = await send("http://127.0.0.1:3000/");
    expect(web.status === 401, `The published web port answered ${String(web.status)} instead of 401`);
    expect(web.body === PROXY_JWT_UNAUTHORIZED_MESSAGE, `Unexpected web 401 body: ${web.body.slice(0, 200)}`);

    // The auth service enforces the same token on /oauth/authorize, and it is
    // the second service an edge misconfiguration would expose. Registration
    // is unauthenticated by design, so the client can be created right here.
    const { parameters } = await createAuthorizationRequest("http://127.0.0.1:8081");
    const query = new URLSearchParams(parameters).toString();
    const auth = await send(`http://127.0.0.1:8081/oauth/authorize?${query}`);
    expect(auth.status === 401, `The published auth port answered ${String(auth.status)} instead of 401`);
    expect(auth.body === PROXY_JWT_UNAUTHORIZED_MESSAGE, `Unexpected auth 401 body: ${auth.body.slice(0, 200)}`);
  }],

  ["the OAuth flow through the edge issues an ebt_at_ access token", async () => {
    state.accessToken = await runOAuthFlow();
  }],

  ["MCP initialize, tools/list and one sql_query succeed", async () => {
    const initialize = parseMcpResult(await mcpCall(state.accessToken, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selfhost-verify", version: "1.0.0" } },
    }));
    expect(typeof initialize?.protocolVersion === "string", "initialize returned no protocolVersion");

    const tools = parseMcpResult(await mcpCall(state.accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    const toolNames = (tools?.tools ?? []).map((tool) => tool.name).sort();
    expect(toolNames.join(",") === "get_guide,get_schema,list_workspaces,sql_execute,sql_query",
      `tools/list returned ${toolNames.join(",")}`);

    const queried = parseMcpResult(await mcpCall(state.accessToken, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "sql_query", arguments: { sql: "SELECT 1 AS one", workspaceId: state.workspaceId } },
    }));
    const payload = readToolPayload(queried);
    expect(payload.ok === true, `sql_query failed: ${JSON.stringify(payload.error ?? payload)}`);
    const rows = payload.data?.statements?.[0]?.rows;
    expect(Array.isArray(rows) && rows.length > 0,
      `sql_query returned no rows: ${JSON.stringify(payload.data).slice(0, 300)}`);
  }],

  ["disabling the user cuts every agent surface, and no request raises the flag back", async () => {
    // Created before the user is disabled: the /v1 refusal below is only worth
    // making with a key that would otherwise have been accepted, which check 9
    // is what proves.
    await ensureAgentApiKey();
    psql(`UPDATE public.users SET cognito_enabled = false, updated_at = now() WHERE user_id = '${SUBJECT}'`);

    const refused = await mcpCall(state.accessToken, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    expect(refused.status === 401, `MCP answered ${String(refused.status)} instead of 401: ${refused.body.slice(0, 300)}`);
    expect(JSON.parse(refused.body).error === "invalid_token", `Unexpected MCP body: ${refused.body}`);

    // The machine API reads the same lever behind an ApiKey, past the token
    // gate that stopped the MCP call above.
    const refusedApi = await send(`https://${API_HOST}/v1/me`, {
      headers: { authorization: `ApiKey ${state.apiKey}` },
    });
    expect(refusedApi.status === 403, `/v1/me answered ${String(refusedApi.status)} instead of 403`);
    expect(JSON.parse(refusedApi.body).error?.code === "account_disabled",
      `/v1/me answered an unexpected body: ${refusedApi.body.slice(0, 300)}`);

    // Consent is the third surface, and the one that could re-provision the
    // account: it must refuse before it writes. It also revokes the live
    // connection, which is why check 7 runs the flow again.
    const { parameters } = await createAuthorizationRequest(`https://${AUTH_HOST}`);
    const consent = await submitConsent(parameters);
    expect(consent.status === 302, `The consent attempt answered ${String(consent.status)} instead of a 302 error redirect`);
    const consentResult = new URL(String(consent.headers.location)).searchParams;
    expect(consentResult.get("error") === "access_denied",
      `The consent attempt returned ${String(consentResult.get("error"))} instead of access_denied`);
    expect(consentResult.get("code") === null, "The consent attempt issued a code to a disabled user");

    // The browser is a separate lever, so it still answers — and that answer
    // writes to the same row, which is what makes "nothing raises the flag
    // back" a claim worth testing rather than a claim about an untouched row.
    const before = readLastSeenEpoch();
    const browser = await browserGet(`https://${APP_HOST}/`);
    expect(browser.status === 200, `The app answered ${String(browser.status)} to a disabled user, expected 200`);
    const after = readLastSeenEpoch();
    expect(after > before,
      `The browser request did not write to the users row (last_seen_at stayed ${String(before)}), so it cannot show the row is left alone`);
    expect(readUserColumn("cognito_enabled") === "f", "An ordinary request raised cognito_enabled back to true");
  }],

  ["re-enabling the user restores MCP access", async () => {
    psql(`UPDATE public.users SET cognito_enabled = true, updated_at = now() WHERE user_id = '${SUBJECT}'`);
    // The refused consent in check 6 revoked the connection behind the old
    // token, so re-enabling alone cannot bring it back.
    const stale = await mcpCall(state.accessToken, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    expect(stale.status === 401, `The revoked token answered ${String(stale.status)} instead of 401`);

    state.accessToken = await runOAuthFlow();
    const tools = parseMcpResult(await mcpCall(state.accessToken, { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }));
    expect((tools?.tools ?? []).length === 5, "tools/list did not come back after re-enabling");
  }],

  ["GET /v1/ answers the discovery envelope on the configured public URLs", async () => {
    const throughEdge = await send(`https://${API_HOST}/v1/`);
    expect(throughEdge.status === 200, `/v1/ answered ${String(throughEdge.status)}, body: ${throughEdge.body.slice(0, 200)}`);
    const envelope = JSON.parse(throughEdge.body);
    expect(envelope.ok === true, "/v1/ answered no success envelope");
    expect(envelope.data?.apiBaseUrl === `https://${API_HOST}/v1`, `Unexpected apiBaseUrl ${String(envelope.data?.apiBaseUrl)}`);
    expect(envelope.data?.mcp?.url === OAUTH_RESOURCE, `Unexpected MCP url ${String(envelope.data?.mcp?.url)}`);

    // Through the edge the Host is already api.<domain>, so the inferred URLs
    // would be byte-identical and PUBLIC_API_BASE_URL/PUBLIC_AUTH_BASE_URL
    // could be deleted without the assertions above noticing. Straight at the
    // published port the Host is 127.0.0.1:8083, which is where an unset pair
    // answers a bare 500 instead of an envelope.
    const direct = await send("http://127.0.0.1:8083/v1/");
    expect(direct.status === 200,
      `/v1/ answered ${String(direct.status)} on a Host that is not api.${DOMAIN}, which is what PUBLIC_API_BASE_URL and PUBLIC_AUTH_BASE_URL prevent: ${direct.body.slice(0, 200)}`);
    const directEnvelope = JSON.parse(direct.body);
    expect(directEnvelope.data?.apiBaseUrl === `https://${API_HOST}/v1`,
      `A direct request advertised apiBaseUrl ${String(directEnvelope.data?.apiBaseUrl)} instead of the configured public URL`);
    expect(directEnvelope.data?.mcp?.url === OAUTH_RESOURCE,
      `A direct request advertised MCP url ${String(directEnvelope.data?.mcp?.url)} instead of the configured public URL`);

    // The email OTP onboarding exists only in AUTH_MODE=cognito: the auth
    // service registers neither /api/agent/send-code nor /api/agent/verify-code
    // here, so an envelope advertising them would send an agent to a 404. The
    // `api` service gets AUTH_MODE=proxy_jwt for exactly this text.
    for (const [label, body] of [["through the edge", envelope], ["direct", directEnvelope]]) {
      expect(body.actions?.some((action) => action.name === "send_code") !== true,
        `The ${label} discovery envelope offers send_code, which answers 404 in proxy_jwt`);
      expect(body.data?.auth?.bootstrapUrl === undefined,
        `The ${label} discovery envelope advertises bootstrapUrl ${String(body.data?.auth?.bootstrapUrl)}, which answers 404 in proxy_jwt`);
      expect(typeof body.instructions === "string" && !body.instructions.includes("send_code"),
        `The ${label} discovery instructions still tell the agent to call send_code`);
      expect(body.instructions.includes("Create an API key"),
        `The ${label} discovery instructions do not name the browser key creation this mode actually serves`);
      // The app is a separate host from this API, so pointing at the browser
      // is useless unless the envelope also says which origin, in a field and
      // in the sentence an agent reads out loud.
      expect(body.data?.appBaseUrl === `https://${APP_HOST}`,
        `The ${label} discovery envelope advertised appBaseUrl ${String(body.data?.appBaseUrl)} instead of the configured https://${APP_HOST}`);
      expect(body.instructions.includes(`browser app at https://${APP_HOST}`),
        `The ${label} discovery instructions do not name https://${APP_HOST} as the place the key is created`);
    }
  }],

  ["oversized bodies are refused by the explicit payload limit on /v1 and /mcp", async () => {
    await ensureAgentApiKey();
    const accepted = await send(`https://${API_HOST}/v1/me`, {
      headers: { authorization: `ApiKey ${state.apiKey}` },
    });
    expect(accepted.status === 200, `The created key was refused by /v1/me: ${String(accepted.status)} ${accepted.body.slice(0, 200)}`);

    const oversized = Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 0x20).toString("latin1");
    const refusedApi = await send(`https://${API_HOST}/v1/sql/query`, {
      method: "POST",
      headers: { authorization: `ApiKey ${state.apiKey}`, "content-type": "application/json" },
      body: oversized,
    });
    expect(refusedApi.status === 413, `/v1 answered ${String(refusedApi.status)} to an oversized body`);
    expect(JSON.parse(refusedApi.body).error?.code === "payload_too_large",
      `/v1 answered an unexpected body: ${refusedApi.body.slice(0, 300)}`);

    const refusedMcp = await mcpCall(state.accessToken, null, { extraBody: oversized });
    expect(refusedMcp.status === 413, `/mcp answered ${String(refusedMcp.status)} to an oversized body`);
    expect(JSON.parse(refusedMcp.body).error === "payload_too_large",
      `/mcp answered an unexpected body: ${refusedMcp.body.slice(0, 300)}`);
  }],

  ["data in the AUTH_MODE=none workspace is unreachable from the proxy identity", async () => {
    // A row only an AUTH_MODE=none boot could have written: workspace 'local'
    // is the pre-seeded subject's workspace and no proxy identity joins it.
    psql(`INSERT INTO ledger_entries (event_id, ts, account_id, amount, currency, kind, note, workspace_id)
          VALUES ('${LOCAL_ROW_MARKER}', now(), 'cash', 1, 'EUR', 'spend', '${LOCAL_ROW_MARKER}', 'local')`);

    const denied = readToolPayload(parseMcpResult(await mcpCall(state.accessToken, {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: {
        name: "sql_query",
        arguments: { sql: `SELECT note FROM ledger_entries WHERE note = '${LOCAL_ROW_MARKER}'`, workspaceId: "local" },
      },
    })));
    expect(denied.ok === false && denied.error?.code === "workspace_not_found",
      `sql_query reached workspace 'local': ${JSON.stringify(denied).slice(0, 300)}`);

    const own = readToolPayload(parseMcpResult(await mcpCall(state.accessToken, {
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: {
        name: "sql_query",
        arguments: { sql: `SELECT note FROM ledger_entries WHERE note = '${LOCAL_ROW_MARKER}'`, workspaceId: state.workspaceId },
      },
    })));
    expect(own.ok === true, `sql_query failed in the proxy identity's own workspace: ${JSON.stringify(own.error ?? own)}`);
    expect((own.data?.statements?.[0]?.rows ?? []).length === 0,
      `The 'local' row was readable from the proxy identity's own workspace: ${JSON.stringify(own.data).slice(0, 300)}`);

    const listed = readToolPayload(parseMcpResult(await mcpCall(state.accessToken, {
      jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_workspaces", arguments: {} },
    })));
    expect(listed.ok === true, `list_workspaces failed: ${JSON.stringify(listed.error ?? listed)}`);
    const visible = JSON.stringify(listed.data);
    expect(!visible.includes('"local"'), `MCP exposed workspace 'local' to the proxy identity: ${visible.slice(0, 300)}`);
    expect(visible.includes(state.workspaceId), "MCP did not expose the proxy identity's own workspace");

    // The browser cannot put 'local' into the active-workspace cookie either:
    // the proxy refuses the value and sends the browser back to bootstrap
    // rather than serving that workspace's data.
    const selected = await send(`https://${APP_HOST}/api/workspaces`, { headers: { cookie: "workspace=local" } });
    expect(selected.status === 307,
      `The app answered ${String(selected.status)} to an active workspace of 'local', expected the bootstrap redirect`);
    expect(String(selected.headers.location).includes("/api/workspaces/bootstrap"),
      `The app redirected to ${String(selected.headers.location)} instead of bootstrap`);
  }],

  ["the MCP gate admits 'PROXY' and denies any other stored status", async () => {
    expect(readUserColumn("cognito_status") === "PROXY", "The provisioned row is not 'PROXY'");
    let refused = null;
    try {
      psql(`UPDATE public.users SET cognito_status = 'PROXY_RENAMED' WHERE user_id = '${SUBJECT}'`);
      refused = await mcpCall(state.accessToken, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    } finally {
      psql(`UPDATE public.users SET cognito_status = 'PROXY' WHERE user_id = '${SUBJECT}'`);
    }
    // A transport failure leaves this null; reporting that is the check
    // failing for a stated reason, not a TypeError on a missing status.
    expect(refused !== null, "The MCP call under the renamed status never completed");
    expect(refused.status === 401,
      `A stored status of 'PROXY_RENAMED' was admitted with ${String(refused.status)}: the gate must admit 'PROXY' and deny every other stored status against a live database`);
    const restored = await mcpCall(state.accessToken, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    expect(restored.status === 200, "Restoring 'PROXY' did not restore MCP access");
  }],
];

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

/**
 * Two different failures land here with the same log action, and they have
 * nothing to do with each other: the CA the stack was given does not cover the
 * edge's JWKS certificate, or, on a Docker without host.docker.internal, the
 * JWKS URL does not resolve at all.
 */
const describeJwksFailure = () => {
  let line;
  try {
    const logs = compose(["logs", "web", "--tail", "40"], { capture: true });
    line = logs.split("\n").reverse().find((entry) => entry.includes("proxy_auth_error"));
  } catch { return; /* the stack may already be gone */ }
  if (line === undefined) return;
  log(`      web container said: ${line.trim()}`);
  // The certificate error names host.docker.internal too, so it is tested first.
  if (/certificate|self-signed/i.test(line)) {
    log("      The containers did not trust the edge CA. SELFHOST_EDGE_CA_DIR and");
    log("      NODE_EXTRA_CA_CERTS in the env file this run wrote should have");
    log(`      mounted ${CA_FILE_NAME} at ${CA_MOUNT_PATH}; see`);
    log("      scripts/selfhost-verify/README.md.");
    return;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(line)) {
    log("      That is a name-resolution failure, not the certificate gap: the");
    log("      containers could not resolve host.docker.internal, which only Docker");
    log("      Desktop provides. This harness does not run on stock Docker Engine.");
  }
};

let edge = null;
let echoServer = null;
let cleanedUp = false;
let teardownFailed = false;

/**
 * The only teardown path. It runs from the finally below and from SIGINT and
 * SIGTERM, so Ctrl-C does not leave the project, its volume, the env file, the
 * CA private key or the fake edge behind.
 */
const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;

  // Lives in this process, so it cannot outlive the run even with --keep-up,
  // and leaving it open would hold the event loop and hang the exit.
  if (echoServer !== null) echoServer.close();

  if (options.keepUp) {
    // The edge stays up on purpose: without its JWKS the surviving stack can
    // verify no identity token and answers 401 on every protected path.
    log("→ --keep-up: leaving the stack and the fake edge running");
    log(`      fake edge: https://127.0.0.1:${String(EDGE_PORT)}, JWKS https://127.0.0.1:${String(EDGE_JWKS_PORT)}`);
    if (edge !== null && edge.pid !== undefined) {
      log(`      stop the edge with: kill ${String(edge.pid)}`);
    } else {
      log("      the fake edge never started, so there is nothing to stop");
    }
    log(`      the ${ECHO_HOST} stand-in upstream stopped with this run, so that`);
    log("      host now answers 502 through the surviving edge.");
    log("      docs/self-hosting.md omits the project flag, which would address the");
    log("      operator's own deployment. Drive this stack with:");
    for (const command of ["ps", "logs web", "down -v"]) {
      log(`        docker ${composeArgs().join(" ")} ${command}`);
    }
    return;
  }

  if (edge !== null) edge.kill("SIGTERM");
  log("→ docker compose down -v");
  try {
    compose(["down", "-v"]);
  } catch (error) {
    teardownFailed = true;
    log(`      teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    log(`      remove it by hand: docker compose -p ${COMPOSE_PROJECT} down -v`);
    log(`      and, if the volume survives: docker volume rm ${COMPOSE_PROJECT}_pgdata`);
  }
  // Holds the CA private key and a valid forged identity token; neither has
  // any reason to outlive the run.
  rmSync(STATE_DIR, { recursive: true, force: true });
};

const installSignalHandlers = () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log(`→ ${signal}: tearing down`);
      cleanup();
      process.exit(130);
    });
  }
};

const main = async () => {
  mkdirSync(STATE_DIR, { recursive: true });
  for (const stale of ["edge-ca.pem", "edge-ca-key.pem", "edge-cert.pem", "edge-key.pem", "edge.csr", "edge-cert.ext"]) {
    rmSync(resolve(STATE_DIR, stale), { force: true });
  }
  rmSync(CA_DIR, { recursive: true, force: true });
  writeEnvFile();
  installSignalHandlers();

  let failed = false;
  try {
    log("→ starting the fake edge");
    echoServer = await startEchoServer();
    edge = await startFakeEdge(echoServer.address().port);
    caCertificate = readFileSync(resolve(STATE_DIR, CA_FILE_NAME));
    // After the edge, which issues the CA, and before the containers, which
    // mount the directory it is published into.
    publishEdgeCa();

    log("→ docker compose up -d --build");
    compose(["up", "-d", "--build"]);
    log("→ waiting for the stack");
    await waitForStack();

    for (const [index, [title, run]] of checks.entries()) {
      const number = index + 1;
      try {
        await run();
        log(`PASS ${String(number)}. ${title}`);
      } catch (error) {
        failed = true;
        log(`FAIL ${String(number)}. ${title}`);
        log(`      ${error instanceof Error ? error.message : String(error)}`);
        if (number === 1) describeJwksFailure();
        break;
      }
    }
  } finally {
    cleanup();
  }

  process.exitCode = failed || teardownFailed ? 1 : 0;
};

await main();
