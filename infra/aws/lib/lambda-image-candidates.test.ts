import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Match, Template } from "aws-cdk-lib/assertions";
import { LAMBDA_IMAGE_ASSET_EXCLUDES, lambdaImageCandidates } from "./lambda-image-candidates";
import { apiGateway } from "./api-gateway";
import { auth } from "./auth";
import { customEmailSenderKey } from "./custom-email-sender";
import { fxFetcher } from "./fx-fetcher";
import { mcpGateway } from "./mcp-gateway";

test("Lambda image staging prunes CDK output after root Docker ignore negations", (): void => {
  const root = path.join(__dirname, "../../..");
  const rootPatterns = readFileSync(path.join(root, ".dockerignore"), "utf8").split("\n").filter(Boolean);
  const outputDirectory = path.join(root, "infra/aws/cdk.out");
  const ignore = cdk.IgnoreStrategy.docker(root, [
    ...rootPatterns,
    ...LAMBDA_IMAGE_ASSET_EXCLUDES,
    "!.dockerignore",
    "!Dockerfile",
    outputDirectory,
  ]);

  assert.equal(ignore.completelyIgnores(outputDirectory), true);
  assert.equal(ignore.completelyIgnores(path.join(outputDirectory, "asset.hash")), true);
  assert.equal(ignore.ignores(path.join(outputDirectory, "asset.hash/.env.example")), true);
  assert.equal(ignore.ignores(path.join(root, ".env.example")), false);
  assert.equal(ignore.ignores(path.join(root, ".env.production")), true);
  assert.equal(ignore.ignores(path.join(root, "infra/aws/lambda-images/Dockerfile")), false);
});

test("production image functions have isolated roles, preserved budgets and direct caller bindings", (): void => {
  const stack = new cdk.Stack(new cdk.App(), "CandidateTest", {
    env: { account: "123456789012", region: "eu-central-1" },
  });
  const vpc = new ec2.Vpc(stack, "Vpc");
  const appDbSecret = new secretsmanager.Secret(stack, "AppSecret");
  const workerDbSecret = new secretsmanager.Secret(stack, "WorkerSecret");
  const resendApiKeySecretArn = "arn:aws:secretsmanager:eu-central-1:123456789012:secret:resend-abcdef";
  const key = customEmailSenderKey(stack, resendApiKeySecretArn);
  const repository = ecr.Repository.fromRepositoryArn(
    stack, "TestImageRepository", "arn:aws:ecr:eu-central-1:123456789012:repository/candidate-test",
  );
  const functions = lambdaImageCandidates(stack, {
    vpc,
    lambdaSg: new ec2.SecurityGroup(stack, "LambdaSg", { vpc }),
    db: new rds.DatabaseInstance(stack, "Db", {
      vpc,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18 }),
    }),
    appDbSecret,
    workerDbSecret,
    chatFilesBucket: new s3.Bucket(stack, "Files"),
    customEmailSenderKey: key,
    resendApiKeySecretArn,
    resendSenderEmail: "sender@example.com",
    baseDomain: "example.com",
  }, (name) => lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: name }));
  const identity = auth(stack, {
    preSignUpFn: functions.signup,
    customEmailSenderFn: functions.email,
    customEmailSenderKey: key,
  });
  const { restApi } = apiGateway(stack, {
    authorizerFn: functions.authorizer,
    sqlApiFn: functions.api,
    baseDomain: "example.com",
    apiCertificateArn: undefined,
  });
  mcpGateway(stack, {
    mcpFn: functions.mcp,
    baseDomain: "example.com",
    mcpCertificateArn: undefined,
  });
  fxFetcher(stack, { fxFetcherFn: functions.fx });
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::Lambda::Function", 7);
  template.resourceCountIs("AWS::Lambda::Permission", 31);
  template.resourceCountIs("AWS::Events::Rule", 1);
  template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.hasResourceProperties("AWS::Cognito::UserPool", {
    LambdaConfig: {
      KMSKeyID: stack.resolve(key.keyArn),
      PreSignUp: stack.resolve(functions.signup.functionArn),
      CustomEmailSender: { LambdaArn: stack.resolve(functions.email.functionArn), LambdaVersion: "V1_0" },
    },
  });
  template.hasResource("AWS::Cognito::UserPool", { DeletionPolicy: "Retain" });
  template.hasResource("AWS::KMS::Key", { DeletionPolicy: "Retain" });
  template.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "cron(0 8 * * ? *)",
    Targets: [Match.objectLike({ Arn: stack.resolve(functions.fx.functionArn) })],
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
    IntegrationUri: stack.resolve(functions.mcp.functionArn),
  });
  const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
  assert.equal(methods.length, 12);
  for (const method of methods) {
    assert.equal(method.Properties.Integration.Type, "AWS_PROXY");
    assert.equal(method.Properties.Integration.IntegrationHttpMethod, "POST");
    assert.ok(JSON.stringify(method.Properties.Integration.Uri).includes(functions.api.node.id));
  }
  assert.deepEqual(restApi.methods.map((method) => `${method.httpMethod} ${method.resource.path}`).sort(), [
    "GET /",
    "GET /agent",
    "GET /me",
    "GET /openapi.json",
    "GET /schema",
    "GET /swagger.json",
    "GET /workspaces",
    "POST /sql",
    "POST /sql/execute",
    "POST /sql/query",
    "POST /workspaces",
    "POST /workspaces/{workspaceId}/select",
  ]);
  const permissions = template.findResources("AWS::Lambda::Permission");
  const apiPermissions = Object.values(permissions).filter((permission) =>
    JSON.stringify(permission.Properties.FunctionName) === JSON.stringify(stack.resolve(functions.api.functionArn)));
  assert.equal(apiPermissions.length, 24);
  for (const method of restApi.methods) {
    const path = method.resource.path === "/workspaces/{workspaceId}/select"
      ? "/workspaces/*/select"
      : method.resource.path;
    for (const [id, stage] of [
      ["ImageInvokePermission", "v1"],
      ["ImageTestInvokePermission", "test-invoke-stage"],
    ]) {
      const permission = method.node.findChild(id);
      assert.ok(permission instanceof lambda.CfnPermission);
      assert.deepEqual(permissions[stack.getLogicalId(permission)]?.Properties, {
        Action: "lambda:InvokeFunction",
        FunctionName: stack.resolve(functions.api.functionArn),
        Principal: "apigateway.amazonaws.com",
        SourceArn: stack.resolve(restApi.arnForExecuteApi(method.httpMethod, path, stage)),
      });
    }
  }
  template.hasResourceProperties("AWS::ApiGateway::Authorizer", {
    AuthorizerUri: Match.anyValue(),
  });
  const authorizers = JSON.stringify(template.findResources("AWS::ApiGateway::Authorizer"));
  assert.ok(authorizers.includes(functions.authorizer.node.id));
  const invokePermissions = Object.values(template.findResources("AWS::Lambda::Permission"));
  const functionArns = Object.values(functions).map((fn) => JSON.stringify(stack.resolve(fn.functionArn)));
  for (const permission of invokePermissions) {
    assert.ok(functionArns.includes(JSON.stringify(permission.Properties.FunctionName)));
    assert.ok(permission.Properties.SourceArn);
  }
  assert.equal(identity.userPool.node.path, "CandidateTest/UserPool");
  assert.equal(identity.userPoolClient.node.path, "CandidateTest/UserPool/AppClient");
  assert.equal(key.node.path, "CandidateTest/CustomEmailSenderKey");
  assert.equal(new Set(Object.values(functions).map((fn) => fn.role?.node.path)).size, 7);
  template.resourceCountIs("AWS::KMS::Key", 1);
  template.allResourcesProperties("AWS::Lambda::Function", {
    PackageType: "Image",
    FunctionName: Match.absent(),
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Architectures: ["arm64"],
    MemorySize: 10240,
    Timeout: 120,
    ReservedConcurrentExecutions: 5,
    VpcConfig: Match.absent(),
    Environment: { Variables: {
      NODE_OPTIONS: "--max-old-space-size=6144",
      CHAT_SANDBOX_OBJECT_HOSTS: Match.anyValue(),
    } },
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Architectures: ["x86_64"],
    MemorySize: 256,
    Timeout: 35,
    ReservedConcurrentExecutions: 20,
    VpcConfig: Match.anyValue(),
    Environment: { Variables: Match.objectLike({
      OAUTH_ISSUER: "https://auth.example.com",
      OAUTH_RESOURCE: "https://mcp.example.com/mcp",
      DB_SECRET_ARN: stack.resolve(appDbSecret.secretArn),
      NODE_EXTRA_CA_CERTS: "/var/task/rds-global-bundle.pem",
    }) },
  });
  const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
  assert.equal(policies.includes("s3:"), false, "Sandbox must rely on caller-presigned URLs");
  assert.equal(policies.includes("lambda:InvokeFunction"), false, "Image execution roles need no invoke grants");
  assert.equal(policies.includes("kms:Encrypt"), false, "Sender needs decrypt only");
});
