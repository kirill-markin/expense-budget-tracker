import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

export interface DatabaseProps {
  vpc: ec2.Vpc;
  dbSg: ec2.SecurityGroup;
}

export interface DatabaseResult {
  db: rds.DatabaseInstance;
  appDbSecret: cdk.aws_secretsmanager.Secret;
}

export function database(scope: Construct, props: DatabaseProps): DatabaseResult {
  // --- RDS Postgres ---
  const dbCredentials = rds.Credentials.fromGeneratedSecret("tracker", {
    secretName: "expense-tracker/db-credentials",
    excludeCharacters: " %+~`#$&*()|[]{}:;<>?!/@\"\\",
  });

  // Audit connections and enforce SSL (critical when Postgres is internet-facing via NLB).
  // Note: rds.force_ssl requires RDS reboot on first apply (~1-2 min downtime).
  const parameterGroup = new rds.ParameterGroup(scope, "DbParams", {
    engine: rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_18,
    }),
    parameters: {
      "log_connections": "all",
      "log_disconnections": "1",
      "rds.force_ssl": "1",
    },
  });

  const db = new rds.DatabaseInstance(scope, "Db", {
    engine: rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_18,
    }),
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.dbSg],
    credentials: dbCredentials,
    databaseName: "tracker",
    parameterGroup,
    allocatedStorage: 20,
    maxAllocatedStorage: 50,
    storageEncrypted: true,
    backupRetention: cdk.Duration.days(7),
    deletionProtection: true,
    removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
  });

  // --- App DB role secret ---
  const appDbSecret = new cdk.aws_secretsmanager.Secret(scope, "AppDbSecret", {
    secretName: "expense-tracker/app-db-password",
    generateSecretString: {
      secretStringTemplate: JSON.stringify({ username: "app" }),
      generateStringKey: "password",
      excludePunctuation: true,
      passwordLength: 32,
    },
  });

  return { db, appDbSecret };
}
