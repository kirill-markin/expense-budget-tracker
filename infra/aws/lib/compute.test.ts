import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const COMPUTE_SOURCE_PATH = path.join(__dirname, "compute.ts");

test("the web Docker asset supplies both the ECS image and Langfuse release", (): void => {
  const source = fs.readFileSync(COMPUTE_SOURCE_PATH, "utf8");
  const assetDeclaration = /const ([A-Za-z][A-Za-z0-9]*) = new DockerImageAsset\(scope, "WebDockerImageAsset",/.exec(source);

  assert.ok(assetDeclaration, "Expected compute.ts to construct one explicit web Docker image asset");
  const assetName = assetDeclaration[1];
  assert.match(
    source,
    new RegExp(`image: ecs\\.ContainerImage\\.fromDockerImageAsset\\(${assetName}\\)`),
  );
  assert.match(
    source,
    new RegExp(`LANGFUSE_RELEASE: ${assetName}\\.assetHash`),
  );
});
