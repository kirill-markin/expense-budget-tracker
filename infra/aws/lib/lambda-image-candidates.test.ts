import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Match, Template } from "aws-cdk-lib/assertions";
import { LAMBDA_IMAGE_ASSET_EXCLUDES, lambdaImageCandidates } from "./lambda-image-candidates";

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

test("image candidates have isolated roles and execution budgets, with no production integrations", (): void => {
  const stack = new cdk.Stack(new cdk.App(), "CandidateTest", {
    env: { account: "123456789012", region: "eu-central-1" },
  });
  const vpc = new ec2.Vpc(stack, "Vpc");
  const appDbSecret = new secretsmanager.Secret(stack, "AppSecret");
  const workerDbSecret = new secretsmanager.Secret(stack, "WorkerSecret");
  const key = new kms.Key(stack, "RetainedSenderKey", { removalPolicy: cdk.RemovalPolicy.RETAIN });
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
    resendApiKeySecretArn: "arn:aws:secretsmanager:eu-central-1:123456789012:secret:resend-abcdef",
    resendSenderEmail: "sender@example.com",
    baseDomain: "example.com",
  }, (name) => lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: name }));
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::Lambda::Function", 7);
  template.resourceCountIs("AWS::Lambda::Permission", 0);
  template.resourceCountIs("AWS::Events::Rule", 0);
  template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
  template.resourceCountIs("AWS::Cognito::UserPool", 0);
  assert.equal(new Set(functions.map((fn) => fn.role?.node.path)).size, 7);
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
  assert.equal(policies.includes("lambda:InvokeFunction"), false, "Candidates must have no invoke grants");
  assert.equal(policies.includes("kms:Encrypt"), false, "Sender candidate needs decrypt only");
});
