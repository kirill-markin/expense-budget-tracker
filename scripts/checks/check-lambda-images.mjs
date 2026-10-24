import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const architecture = process.argv[2];
assert.ok(architecture === "amd64" || architecture === "arm64", "Specify amd64 or arm64");
const bases = JSON.parse(await readFile("infra/aws/lambda-images/bases.json", "utf8"));
const functions = architecture === "arm64" ? ["sandbox"] : ["fx", "authorizer", "api", "mcp", "signup", "email"];
const timeouts = { fx: 300, authorizer: 10, api: 35, mcp: 35, sandbox: 120, signup: 3, email: 30 };
const docker = (args, options) => execFileSync("docker", args, { timeout: 1_200_000, ...options });

for (const name of functions) {
  const tag = `lambda-image-check:${name}`;
  docker([
    "build", "--platform", `linux/${architecture}`, "--file", "infra/aws/lambda-images/Dockerfile",
    "--build-arg", `AWS_NODE_BASE=${bases[architecture]}`, "--build-arg", `FUNCTION=${name}`, "--tag", tag, ".",
  ], { stdio: "inherit" });
  const container = docker([
    "run", "--detach", "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--user", "10001:10001",
    "--publish", "127.0.0.1::8080",
    "--env", "AWS_REGION=eu-central-1", "--env", "AWS_DEFAULT_REGION=eu-central-1",
    "--env", `AWS_LAMBDA_FUNCTION_TIMEOUT=${timeouts[name]}`,
    "--env", "AWS_ACCESS_KEY_ID=image-probe", "--env", "AWS_SECRET_ACCESS_KEY=image-probe",
    "--env", "AWS_EC2_METADATA_DISABLED=true",
    "--env", "NODE_EXTRA_CA_CERTS=/var/task/rds-global-bundle.pem",
    "--env", "NODE_OPTIONS=--max-old-space-size=6144",
    "--env", "CHAT_SANDBOX_OBJECT_HOSTS=image-probe.invalid",
    "--env", "PUBLIC_API_BASE_URL=https://api.example.com/v1",
    "--env", "PUBLIC_AUTH_BASE_URL=https://auth.example.com",
    "--env", "OAUTH_ISSUER=https://auth.example.com",
    "--env", "OAUTH_RESOURCE=https://mcp.example.com/mcp",
    tag, "probe.handler",
  ], { encoding: "utf8" }).trim();
  try {
    const endpoint = docker(["port", container, "8080/tcp"], { encoding: "utf8" }).trim();
    let response;
    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        response = await fetch(`http://${endpoint}/2015-03-31/functions/function/invocations`, {
          method: "POST", body: "{}", signal: AbortSignal.timeout(120_000),
        });
        break;
      } catch (error) {
        if (attempt === 20) throw error;
        process.stderr.write(`Lambda image ${name} emulator connection attempt ${attempt}/20 failed: ${String(error)}\n`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    assert.ok(response?.ok, `Lambda image ${name} emulator returned HTTP ${response?.status}`);
    const body = await response.json();
    assert.equal(body.packagedHandler, "ok", JSON.stringify(body));
    assert.equal(body.function, name);
    assert.equal(body.supervisor.architecture, architecture === "arm64" ? "arm64" : "x64");
    assert.equal(body.child.node, body.supervisor.node);
    const logs = docker(["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (name === "sandbox") {
      const childLogs = logs.split("\n").filter((line) => line.includes('"process":"sandbox_session_child"'));
      assert.ok(childLogs.some((line) => line.includes(`"node":"${body.supervisor.node}"`)), "Actual sandbox session child must assert and report the patched Node version");
    }
    process.stdout.write(`${JSON.stringify(body)}\n`);
  } finally {
    docker(["logs", container], { stdio: "inherit" });
    docker(["rm", "--force", container], { stdio: "inherit" });
  }
}
