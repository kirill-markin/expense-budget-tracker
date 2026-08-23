import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Template } from "aws-cdk-lib/assertions";
import { ingress } from "./ingress";
import { networking } from "./networking";

// The peers CDK attaches to the ALB security group when a listener is created without
// `open: false`. They never appear in repository source, only in the synthesized template.
const OPEN_TO_INTERNET_IPV4 = "0.0.0.0/0";
const OPEN_TO_INTERNET_IPV6 = "::/0";

// ELBv2 access logging resolves a region-specific log-delivery principal, so the stack
// under test cannot be environment-agnostic.
const TEST_ENV: cdk.Environment = { account: "123456789012", region: "eu-central-1" };
const TEST_CERTIFICATE_ARN =
  "arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000";

type IngressRuleShape = "inline" | "standalone";

type IngressRule = Readonly<{
  shape: IngressRuleShape;
  cidrIp: string | undefined;
  cidrIpv6: string | undefined;
  ipProtocol: string | undefined;
  fromPort: number | undefined;
  toPort: number | undefined;
}>;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a template object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a literal string, got ${JSON.stringify(value)}`);
  }
  return value;
};

const optionalNumber = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`Expected ${field} to be a literal number, got ${JSON.stringify(value)}`);
  }
  return value;
};

const toIngressRule = (shape: IngressRuleShape, properties: unknown): IngressRule => {
  const rule = asRecord(properties);
  return {
    shape,
    cidrIp: optionalString(rule.CidrIp, "CidrIp"),
    cidrIpv6: optionalString(rule.CidrIpv6, "CidrIpv6"),
    ipProtocol: optionalString(rule.IpProtocol, "IpProtocol"),
    fromPort: optionalNumber(rule.FromPort, "FromPort"),
    toPort: optionalNumber(rule.ToPort, "ToPort"),
  };
};

const stubFargateService = (
  stack: cdk.Stack,
  cluster: ecs.Cluster,
  serviceSg: ec2.SecurityGroup,
  id: string,
  containerPort: number,
): ecs.FargateService => {
  const taskDefinition = new ecs.FargateTaskDefinition(stack, `${id}TaskDef`, {
    cpu: 256,
    memoryLimitMiB: 512,
  });
  taskDefinition.addContainer("app", {
    image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/nginx:stable"),
    portMappings: [{ containerPort }],
  });
  return new ecs.FargateService(stack, `${id}Service`, {
    cluster,
    taskDefinition,
    securityGroups: [serviceSg],
  });
};

// ExpenseBudgetTrackerStack cannot be synthesized here: compute.ts builds Docker image
// assets and the Lambda constructs bundle with esbuild, neither of which may run during
// `npm test`. networking() and ingress() are the real production functions, so a listener
// that loses `open: false` reopens this template exactly as it would reopen production.
const synthesizeIngressTemplate = (): Template => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "AlbSecurityGroupTestStack", { env: TEST_ENV });
  const net = networking(stack);
  const cluster = new ecs.Cluster(stack, "Cluster", { vpc: net.vpc });
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    "Certificate",
    TEST_CERTIFICATE_ARN,
  );
  ingress(stack, {
    vpc: net.vpc,
    albSg: net.albSg,
    certificate,
    webService: stubFargateService(stack, cluster, net.ecsSg, "Web", 8080),
    authService: stubFargateService(stack, cluster, net.ecsSg, "Auth", 8081),
    baseDomain: "example.com",
    appDomain: "app.example.com",
    authDomain: "auth.example.com",
    originSharedSecret: "test-origin-secret",
  });
  return Template.fromStack(stack);
};

// Resolved from the ALB itself rather than from a security group name or description, so
// renaming or relocating the group cannot make the assertions below pass vacuously.
const albSecurityGroupLogicalId = (template: Template): string => {
  const loadBalancers = Object.values(
    template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"),
  );
  if (loadBalancers.length !== 1) {
    throw new Error(`Expected exactly one ALB, found ${loadBalancers.length}`);
  }
  const securityGroups = asRecord(asRecord(loadBalancers[0]).Properties).SecurityGroups;
  if (!Array.isArray(securityGroups) || securityGroups.length !== 1) {
    throw new Error(
      `Expected the ALB to reference exactly one security group, got ${JSON.stringify(securityGroups)}`,
    );
  }
  const getAtt = asRecord(securityGroups[0])["Fn::GetAtt"];
  if (!Array.isArray(getAtt) || typeof getAtt[0] !== "string") {
    throw new Error(
      `Expected an Fn::GetAtt security group reference, got ${JSON.stringify(securityGroups[0])}`,
    );
  }
  return getAtt[0];
};

const inlineIngressRules = (
  template: Template,
  securityGroupLogicalId: string,
): ReadonlyArray<IngressRule> => {
  const securityGroup = template.findResources("AWS::EC2::SecurityGroup")[securityGroupLogicalId];
  if (securityGroup === undefined) {
    throw new Error(`Expected AWS::EC2::SecurityGroup ${securityGroupLogicalId} in the template`);
  }
  const inline = asRecord(asRecord(securityGroup).Properties).SecurityGroupIngress;
  if (inline === undefined) return [];
  if (!Array.isArray(inline)) {
    throw new Error(`Expected SecurityGroupIngress to be a list, got ${JSON.stringify(inline)}`);
  }
  return inline.map((rule) => toIngressRule("inline", rule));
};

const opensSecurityGroup = (groupId: unknown, securityGroupLogicalId: string): boolean => {
  if (typeof groupId === "string") return groupId === securityGroupLogicalId;
  if (typeof groupId !== "object" || groupId === null) return false;
  const reference = groupId as Record<string, unknown>;
  if (reference.Ref === securityGroupLogicalId) return true;
  const getAtt = reference["Fn::GetAtt"];
  return Array.isArray(getAtt) && getAtt[0] === securityGroupLogicalId;
};

const standaloneIngressRules = (
  template: Template,
  securityGroupLogicalId: string,
): ReadonlyArray<IngressRule> =>
  Object.values(template.findResources("AWS::EC2::SecurityGroupIngress"))
    .map((resource) => asRecord(asRecord(resource).Properties))
    .filter((properties) => opensSecurityGroup(properties.GroupId, securityGroupLogicalId))
    .map((properties) => toIngressRule("standalone", properties));

const readCloudflareCidrs = (): ReadonlyArray<string> => {
  const raw = fs.readFileSync(path.join(__dirname, "../cloudflare-ips.json"), "utf8");
  const cidrs = asRecord(JSON.parse(raw) as unknown).ipv4_cidrs;
  if (!Array.isArray(cidrs) || cidrs.some((cidr) => typeof cidr !== "string")) {
    throw new Error(`Expected cloudflare-ips.json to hold ipv4_cidrs strings, got ${raw}`);
  }
  return cidrs as ReadonlyArray<string>;
};

test("ALB security group has no ingress rule open to the whole internet", (): void => {
  const template = synthesizeIngressTemplate();
  const albSg = albSecurityGroupLogicalId(template);
  const inline = inlineIngressRules(template, albSg);
  const standalone = standaloneIngressRules(template, albSg);

  // Guards the negative assertions against an ALB security group that carries no rules.
  assert.ok(inline.length > 0, "Expected inline ingress rules on the ALB security group");

  const openToInternet = [...inline, ...standalone].filter(
    (rule) => rule.cidrIp === OPEN_TO_INTERNET_IPV4 || rule.cidrIpv6 === OPEN_TO_INTERNET_IPV6,
  );
  assert.deepEqual(openToInternet, []);
});

test("ALB security group still admits every Cloudflare CIDR on ports 80 and 443", (): void => {
  const template = synthesizeIngressTemplate();
  const albSg = albSecurityGroupLogicalId(template);
  const rules = [
    ...inlineIngressRules(template, albSg),
    ...standaloneIngressRules(template, albSg),
  ];
  const cloudflareCidrs = readCloudflareCidrs();
  assert.ok(cloudflareCidrs.length > 0);

  for (const cidr of cloudflareCidrs) {
    for (const port of [80, 443]) {
      assert.ok(
        rules.some((rule) =>
          rule.cidrIp === cidr
          && rule.ipProtocol === "tcp"
          && rule.fromPort === port
          && rule.toPort === port),
        `Expected ALB security group ingress from ${cidr} on tcp/${port}`,
      );
    }
  }
});

// Standalone AWS::EC2::SecurityGroupIngress resources are the second shape a reopened ALB
// can take. This proves the GroupId matcher attributes real standalone rules, so finding
// none on the ALB security group is a fact about the template, not a broken lookup.
test("standalone ingress rules are attributed to the security group they open", (): void => {
  const template = synthesizeIngressTemplate();
  const standaloneCount = Object.keys(
    template.findResources("AWS::EC2::SecurityGroupIngress"),
  ).length;
  assert.ok(standaloneCount > 0, "Expected standalone ingress resources in the template");

  const attributed = Object.keys(template.findResources("AWS::EC2::SecurityGroup"))
    .flatMap((logicalId) => standaloneIngressRules(template, logicalId));
  assert.equal(attributed.length, standaloneCount);
  assert.deepEqual(standaloneIngressRules(template, albSecurityGroupLogicalId(template)), []);
});
