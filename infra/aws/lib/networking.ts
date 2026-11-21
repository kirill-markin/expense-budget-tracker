import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { createHash } from "crypto";
import * as path from "path";
import * as fs from "fs";

export interface NetworkingProps {
  natAmiId: string;
}

export interface NetworkingResult {
  vpc: ec2.Vpc;
  albSg: ec2.SecurityGroup;
  ecsSg: ec2.SecurityGroup;
  dbSg: ec2.SecurityGroup;
  lambdaSg: ec2.SecurityGroup;
  migrateSg: ec2.SecurityGroup;
}

// Amazon Linux 2023 locks its repositories to the image's release, so without the
// releasever override dnf-automatic would find no updates on a pinned image.
// `dnf needs-restarting -r` exits 1 only when an installed update needs a reboot.
const NAT_SELF_UPDATE_COMMANDS: string[] = [
  "echo latest > /etc/dnf/vars/releasever",
  "dnf install -y dnf-automatic dnf-plugins-core",
  "sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf",
  "systemctl enable --now dnf-automatic.timer",
  [
    "cat > /etc/systemd/system/nat-kernel-restart.service <<'EOF'",
    "[Unit]",
    "Description=Restart the NAT instance when an installed update needs a reboot",
    "[Service]",
    "Type=oneshot",
    "ExecStart=/bin/sh -c 'dnf needs-restarting -r || systemctl reboot'",
    "EOF",
  ].join("\n"),
  [
    "cat > /etc/systemd/system/nat-kernel-restart.timer <<'EOF'",
    "[Unit]",
    "Description=Weekly NAT instance restart check",
    "[Timer]",
    "OnCalendar=Sun *-*-* 04:00:00 UTC",
    "[Install]",
    "WantedBy=timers.target",
    "EOF",
  ].join("\n"),
  "systemctl daemon-reload",
  "systemctl enable --now nat-kernel-restart.timer",
];

export function networking(scope: Construct, props: NetworkingProps): NetworkingResult {
  // --- VPC ---
  // NAT instance (t4g.small ~$12/mo) instead of managed NAT Gateway (~$35/mo).
  // Trade-off: no HA, no auto-recovery, limited bandwidth (~5 Gbps burst).
  // Acceptable for a pet project where only the Lambda FX fetcher and ECS tasks use NAT
  // (a few KB/day + ECR image pulls). To switch to managed NAT Gateway, remove
  // natGatewayProvider and keep only: natGateways: 1,
  // The image is pinned through the `natAmiId` context so a new Amazon Linux release does
  // not replace the instance on deploy; instead the instance installs security updates daily
  // and restarts on Sundays at 04:00 UTC only when one of them needs a reboot. Each
  // replacement, on an image or user data change, cuts private-subnet egress for about a minute.
  const natUserData = ec2.UserData.forLinux();
  natUserData.addCommands(
    ...ec2.NatInstanceProviderV2.DEFAULT_USER_DATA_COMMANDS,
    ...NAT_SELF_UPDATE_COMMANDS,
  );
  const natProvider = ec2.NatProvider.instanceV2({
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
    machineImage: ec2.MachineImage.genericLinux({ [cdk.Stack.of(scope).region]: props.natAmiId }),
    userData: natUserData,
    defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
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
  natProvider.securityGroup.addIngressRule(
    ec2.Peer.ipv4(vpc.vpcCidrBlock),
    ec2.Port.allTraffic(),
    "Allow VPC traffic to NAT instance",
  );
  // An EBS-backed instance only stops and starts on a UserData change, and cloud-init does
  // not rerun the script. NatInstanceProviderV2 has no userDataCausesReplacement option, so
  // this applies the same mechanism ec2.Instance uses for it: a user data digest suffix on
  // the logical ID makes CloudFormation replace the instance.
  for (const natInstance of natProvider.gatewayInstances) {
    const stack = cdk.Stack.of(natInstance);
    const userDataDigest = createHash("md5")
      .update(JSON.stringify(stack.resolve(natInstance.userData.render())))
      .digest("hex")
      .slice(0, 16);
    natInstance.instance.overrideLogicalId(
      `${stack.getLogicalId(natInstance.instance)}${userDataDigest}`,
    );
  }

  // Keeps chat file object traffic off the single NAT instance: a gateway
  // endpoint routes S3 requests from the private subnets directly to S3.
  vpc.addGatewayEndpoint("S3GatewayEndpoint", {
    service: ec2.GatewayVpcEndpointAwsService.S3,
    subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
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
