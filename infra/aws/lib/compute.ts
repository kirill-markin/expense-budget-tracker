import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as rds from "aws-cdk-lib/aws-rds";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";

export interface ComputeProps {
  vpc: ec2.Vpc;
  ecsSg: ec2.SecurityGroup;
  db: rds.DatabaseInstance;
  appDbSecret: cdk.aws_secretsmanager.Secret;
  openaiApiKeySecret: cdk.aws_secretsmanager.Secret;
  anthropicApiKeySecret: cdk.aws_secretsmanager.Secret;
  authDomain: string;
  userPoolClientId: string;
  appDomain: string;
  directAccessHost: string;
}

export interface ComputeResult {
  cluster: ecs.Cluster;
  webService: ecs.FargateService;
  migrateTaskDef: ecs.FargateTaskDefinition;
  migrateLogGroup: logs.LogGroup;
}

export function compute(scope: Construct, props: ComputeProps): ComputeResult {
  // --- ECS Cluster + Web Service ---
  // Docker images are built and pushed by CDK via fromAsset() — no manual ECR repos needed.
  // CDK uses the bootstrap ECR repo (cdk-hnb659fds-container-assets-*) for image storage.
  const cluster = new ecs.Cluster(scope, "Cluster", { vpc: props.vpc });

  const webTaskDef = new ecs.FargateTaskDefinition(scope, "WebTask", {
    cpu: 512,
    memoryLimitMiB: 1024,
    runtimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
  });

  const webLogGroup = new logs.LogGroup(scope, "WebLogGroup", {
    logGroupName: "/expense-tracker/web",
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  webTaskDef.addContainer("web", {
    image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../../apps/web"), {
      platform: Platform.LINUX_ARM64,
    }),
    portMappings: [{ containerPort: 8080 }],
    environment: {
      AUTH_MODE: "proxy",
      AUTH_PROXY_HEADER: "x-amzn-oidc-data",
      HOSTNAME: "0.0.0.0",
      CORS_ORIGIN: `https://${props.appDomain}`,
      COGNITO_DOMAIN: props.authDomain,
      COGNITO_CLIENT_ID: props.userPoolClientId,
      DB_HOST: props.db.dbInstanceEndpointAddress,
      DIRECT_ACCESS_HOST: props.directAccessHost,
      DB_NAME: "tracker",
      DB_USER: "app",
      // RDS certs are signed by Amazon's CA, not in the Node.js trust store.
      // Points to the CA bundle downloaded in apps/web/Dockerfile.
      NODE_EXTRA_CA_CERTS: "/app/rds-global-bundle.pem",
    },
    secrets: {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, "password"),
      OPENAI_API_KEY: ecs.Secret.fromSecretsManager(props.openaiApiKeySecret),
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(props.anthropicApiKeySecret),
    },
    logging: ecs.LogDrivers.awsLogs({
      logGroup: webLogGroup,
      streamPrefix: "web",
    }),
    healthCheck: {
      command: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8080/api/health || exit 1"],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.seconds(60),
    },
  });

  // Near-zero-downtime rolling update: with the ECS defaults (minHealthyPercent=100%,
  // maxPercent=200%) a new task starts alongside the old one. ALB routes traffic to
  // both until the new task is healthy, then drains the old one (deregistration delay 300s).
  // The only source of user-visible delay is database migrations that lock tables.
  const webService = new ecs.FargateService(scope, "WebService", {
    cluster,
    taskDefinition: webTaskDef,
    desiredCount: 1,
    assignPublicIp: false,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.ecsSg],
    circuitBreaker: { enable: true },
  });

  // Auto-scaling: 1–3 tasks, scale on CPU. Hard cap at 3 to limit cost.
  const scaling = webService.autoScaleTaskCount({
    minCapacity: 1,
    maxCapacity: 3,
  });
  scaling.scaleOnCpuUtilization("CpuScaling", {
    targetUtilizationPercent: 70,
    scaleInCooldown: cdk.Duration.minutes(10),
    scaleOutCooldown: cdk.Duration.minutes(3),
  });

  // --- Migration Task Definition (one-off, not a service) ---
  const migrateTaskDef = new ecs.FargateTaskDefinition(scope, "MigrateTask", {
    cpu: 256,
    memoryLimitMiB: 512,
    runtimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
  });

  const migrateLogGroup = new logs.LogGroup(scope, "MigrateLogGroup", {
    logGroupName: "/expense-tracker/migrate",
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // Migration needs the DB owner (tracker) credentials to run DDL + create the app role.
  migrateTaskDef.addContainer("migrate", {
    image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../.."), {
      file: "infra/docker/Dockerfile.migrate",
      platform: Platform.LINUX_ARM64,
      exclude: [".git", "**/node_modules", "**/cdk.out", "apps", "docs", ".next"],
    }),
    environment: {
      DB_HOST: props.db.dbInstanceEndpointAddress,
      DB_NAME: "tracker",
    },
    secrets: {
      DB_USER: ecs.Secret.fromSecretsManager(props.db.secret!, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(props.db.secret!, "password"),
      APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, "password"),
    },
    logging: ecs.LogDrivers.awsLogs({
      logGroup: migrateLogGroup,
      streamPrefix: "migrate",
    }),
  });

  return { cluster, webService, migrateTaskDef, migrateLogGroup };
}
