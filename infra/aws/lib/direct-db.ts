/**
 * Direct database access: internet-facing NLB that routes TCP:5432 to RDS.
 *
 * Why NLB -> RDS (no PgBouncer): PgBouncer's auth_query cannot read password
 * hashes on RDS (pg_shadow/pg_authid are locked by rdsadmin). A userlist.txt
 * workaround adds sync complexity not justified at current scale. BI tools
 * hold 1-5 long-lived connections — pooling is unnecessary.
 *
 * Security: SCRAM-SHA-256, rds.force_ssl, CONNECTION LIMIT 5, statement_timeout
 * 30s, RLS on all data tables, CloudWatch alarms on connection count.
 *
 * Cost: ~$21-26/mo (NLB fixed ~$16 + NLCU ~$5-10 for light BI usage).
 *
 * IP lookup: NLB target groups require an IP, not a hostname. An
 * AwsCustomResource calls EC2 describeNetworkInterfaces to find the RDS ENI's
 * private IP at deploy time. If RDS fails over to a different AZ, the target
 * IP becomes stale until the next CDK deploy. Acceptable for a single-user
 * project; for HA, add a Lambda that updates targets on RDS event notifications.
 */
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface DirectDbProps {
  vpc: ec2.Vpc;
  dbSg: ec2.SecurityGroup;
  db: rds.DatabaseInstance;
  baseDomain: string;
}

export interface DirectDbResult {
  nlb: elbv2.NetworkLoadBalancer;
  nlbSg: ec2.SecurityGroup;
}

export function directDb(scope: Construct, props: DirectDbProps): DirectDbResult {
  // --- Security Group ---
  const nlbSg = new ec2.SecurityGroup(scope, "NlbDbSg", {
    vpc: props.vpc,
    description: "NLB: allow Postgres from internet for direct DB access",
  });
  nlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), "Postgres from internet");
  props.dbSg.addIngressRule(nlbSg, ec2.Port.tcp(5432), "NLB to Postgres");

  // --- Network Load Balancer ---
  const nlb = new elbv2.NetworkLoadBalancer(scope, "DbNlb", {
    vpc: props.vpc,
    internetFacing: true,
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    securityGroups: [nlbSg],
  });

  // --- Resolve RDS private IP via ENI lookup ---
  // NLB target groups require an IP address, not a DNS hostname.
  // The dbSg is dedicated to RDS — filtering by group-id returns its ENI.
  const describeCall: cr.AwsSdkCall = {
    service: "EC2",
    action: "describeNetworkInterfaces",
    parameters: {
      Filters: [
        { Name: "group-id", Values: [props.dbSg.securityGroupId] },
        { Name: "status", Values: ["in-use"] },
      ],
    },
    physicalResourceId: cr.PhysicalResourceId.of("rds-eni-ip"),
    outputPaths: ["NetworkInterfaces.0.PrivateIpAddress"],
  };

  const rdsIpLookup = new cr.AwsCustomResource(scope, "RdsIpLookup", {
    onCreate: describeCall,
    onUpdate: describeCall,
    policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
      resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
    }),
  });
  rdsIpLookup.node.addDependency(props.db);

  const rdsIp = rdsIpLookup.getResponseField("NetworkInterfaces.0.PrivateIpAddress");

  // --- Target Group (IP type, resolved RDS IP) ---
  const cfnTg = new elbv2.CfnTargetGroup(scope, "DbNlbTg", {
    name: "db-nlb-tg",
    protocol: "TCP",
    port: 5432,
    targetType: "ip",
    vpcId: props.vpc.vpcId,
    healthCheckProtocol: "TCP",
    healthCheckPort: "5432",
    targets: [{
      id: rdsIp,
      port: 5432,
    }],
  });

  // --- TCP Listener ---
  const cfnListener = new elbv2.CfnListener(scope, "DbNlbListener", {
    loadBalancerArn: nlb.loadBalancerArn,
    protocol: "TCP",
    port: 5432,
    defaultActions: [{
      type: "forward",
      targetGroupArn: cfnTg.ref,
    }],
  });
  cfnListener.addPropertyOverride("ListenerAttributes", [
    { Key: "tcp.idle_timeout.seconds", Value: "3600" },
  ]);

  return { nlb, nlbSg };
}
