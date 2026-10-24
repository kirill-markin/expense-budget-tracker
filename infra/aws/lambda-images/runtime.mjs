import { checkServerIdentity } from "node:tls";

export const assertPatchedRuntime = () => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) {
    throw new Error(`Lambda image requires Node >=24.22.1 <25; actual=${process.version}`);
  }
  // A noncanonical IP must not match a canonical IP SAN.
  if (checkServerIdentity("127.000.000.001", { subjectaltname: "IP Address:127.0.0.1" }) === undefined) {
    throw new Error("Lambda Node TLS verification accepted a noncanonical IP SAN match");
  }
  return { node: process.version, architecture: process.arch, execPath: process.execPath };
};

const runtime = assertPatchedRuntime();
process.stdout.write(`${JSON.stringify({
  domain: "lambda_image",
  action: "runtime_verified",
  process: process.env.CHAT_SANDBOX_SESSION_CHILD === "1"
    ? "sandbox_session_child"
    : process.env.CHAT_SANDBOX_PREPARE_CHILD === "1" ? "sandbox_prepare_child" : "supervisor",
  ...runtime,
})}\n`);
