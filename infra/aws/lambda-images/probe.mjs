import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { assertPatchedRuntime } from "./runtime.mjs";
import * as entry from "./index.mjs";

// Select with Lambda ImageConfig.Command=probe.handler, never with an event flag.
export const handler = async (_event, context) => {
  assert.equal(typeof entry.handler, "function", "Packaged production handler must initialize");
  const supervisor = assertPatchedRuntime();
  const child = JSON.parse(execFileSync(process.execPath, [
    "--input-type=module", "-e",
    "import { assertPatchedRuntime } from './runtime.mjs'; process.stdout.write(JSON.stringify(assertPatchedRuntime()));",
  ], { cwd: "/var/task", encoding: "utf8", timeout: 10_000 }).trim().split("\n").at(-1));
  assert.equal(child.node, supervisor.node);
  const functionName = process.env.LAMBDA_IMAGE_FUNCTION;
  switch (functionName) {
    case "sandbox":
      await entry.runSandboxSmoke(context);
      break;
    case "signup": {
      const result = await entry.handler({ request: { userAttributes: { email: "probe@example.com" } }, response: {} });
      assert.equal(result.response.autoConfirmUser, true);
      assert.equal(result.response.autoVerifyEmail, true);
      break;
    }
    case "authorizer": {
      const result = await entry.handler({ authorizationToken: "", methodArn: "arn:aws:execute-api:eu-central-1:123456789012:probe/v1/GET/" });
      assert.equal(result.policyDocument.Statement[0].Effect, "Deny");
      break;
    }
    case "api": {
      const result = await entry.handler({ httpMethod: "GET", path: "/v1/", headers: {}, requestContext: {} });
      assert.equal(result.statusCode, 200);
      assert.ok(JSON.parse(result.body));
      break;
    }
    case "mcp": {
      const result = await entry.handler({
        version: "2.0", rawPath: "/.well-known/oauth-protected-resource/mcp", rawQueryString: "",
        routeKey: "GET /.well-known/oauth-protected-resource/mcp",
        headers: { host: new URL(process.env.OAUTH_RESOURCE).host }, isBase64Encoded: false,
        requestContext: { http: { method: "GET", path: "/.well-known/oauth-protected-resource/mcp" } },
      });
      assert.equal(result.statusCode, 200);
      assert.equal(JSON.parse(result.body).resource, process.env.OAUTH_RESOURCE);
      break;
    }
    case "fx":
    case "email":
      // Importing initializes real SDK clients; invoking would fetch data or send mail.
      break;
    default:
      throw new Error(`Unknown LAMBDA_IMAGE_FUNCTION: ${functionName}`);
  }
  return { function: functionName, supervisor, child, packagedHandler: "ok" };
};
