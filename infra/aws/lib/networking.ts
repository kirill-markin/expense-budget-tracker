import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";

export interface NetworkingResult {
  vpc: ec2.Vpc;
  albSg: ec2.SecurityGroup;
  ecsSg: ec2.SecurityGroup;
  dbSg: ec2.SecurityGroup;
  lambdaSg: ec2.SecurityGroup;
  migrateSg: ec2.SecurityGroup;
}

export function networking(scope: Construct): NetworkingResult {
  // --- VPC ---
  // NAT instance (t4g.micro ~$6/mo) instead of managed NAT Gateway (~$35/mo).
  // Trade-off: no HA, no auto-recovery, limited bandwidth (~5 Gbps burst).
  // Acceptable for a pet project where only the Lambda FX fetcher and ECS tasks use NAT
  // (a few KB/day + ECR image pulls). To switch to managed NAT Gateway, remove
  // natGatewayProvider and keep only: natGateways: 1,
  const natProvider = ec2.NatProvider.instanceV2({
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
  });
  const vpc = new ec2.Vpc(scope, "Vpc", {
    maxAzs: 2,
    natGatewayProvider: natProvider,
    natGateways: 1,
    subnetConfiguration: [
      { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    ],
  });

  // --- Security Groups ---
  // ALB only accepts traffic from Cloudflare edge servers.
  // IPs loaded from cloudflare-ips.json — run scripts/update-cloudflare-ips.sh to refresh.
  const cfIpsPath = path.join(__dirname, "../cloudflare-ips.json");
  const cfIpsData = JSON.parse(fs.readFileSync(cfIpsPath, "utf8")) as { ipv4_cidrs: string[] };
  const cloudflareCidrs = cfIpsData.ipv4_cidrs;
  const albSg = new ec2.SecurityGroup(scope, "AlbSg", {
    vpc,
    description: "ALB: allow HTTP/HTTPS from Cloudflare only",
  });
  for (const cidr of cloudflareCidrs) {
    albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `CF ${cidr}`);
    albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(443), `CF ${cidr}`);
  }

  const ecsSg = new ec2.SecurityGroup(scope, "EcsSg", {
    vpc,
    description: "ECS: allow traffic from ALB",
  });
  ecsSg.addIngressRule(albSg, ec2.Port.tcp(8080), "ALB to web app");

  const dbSg = new ec2.SecurityGroup(scope, "DbSg", {
    vpc,
    description: "RDS: allow traffic from ECS and Lambda",
  });
  dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), "ECS to Postgres");

  const lambdaSg = new ec2.SecurityGroup(scope, "LambdaSg", {
    vpc,
    description: "Lambda: FX fetchers, SQL API",
  });
  dbSg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), "Lambda to Postgres");

  // Migration task runs in private subnets with access to RDS
  const migrateSg = new ec2.SecurityGroup(scope, "MigrateSg", {
    vpc,
    description: "ECS migrate task: access to RDS",
  });
  dbSg.addIngressRule(migrateSg, ec2.Port.tcp(5432), "Migrate task to Postgres");

  return { vpc, albSg, ecsSg, dbSg, lambdaSg, migrateSg };
}
