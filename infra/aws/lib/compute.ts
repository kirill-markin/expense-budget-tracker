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
  authDbSecret: cdk.aws_secretsmanager.Secret;
  workerDbSecret: cdk.aws_secretsmanager.Secret;
  sessionEncryptionKeySecret: cdk.aws_secretsmanager.Secret;
  openaiApiKeySecret: cdk.aws_secretsmanager.Secret;
  anthropicApiKeySecret: cdk.aws_secretsmanager.Secret;
  userPoolId: string;
  userPoolClientId: string;
  appDomain: string;
  authDomain: string;
}

export interface ComputeResult {
  cluster: ecs.Cluster;
  webService: ecs.FargateService;
  webContainer: ecs.ContainerDefinition;
  authService: ecs.FargateService;
  migrateTaskDef: ecs.FargateTaskDefinition;
  migrateLogGroup: logs.LogGroup;
}

export function compute(scope: Construct, props: ComputeProps): ComputeResult {
  // --- ECS Cluster + Web Service ---
  // Docker images are built and pushed by CDK via fromAsset() — no manual ECR repos needed.
  // CDK uses the bootstrap ECR repo (cdk-hnb659fds-container-assets-*) for image storage.
  const rootDockerAssetExclude = [
    ".git",
    ".github",
    "**/node_modules",
    "**/.next",
    "**/dist",
    "**/cdk.out",
  ];
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

  const webContainer = webTaskDef.addContainer("web", {
    image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../.."), {
      file: "apps/web/Dockerfile",
      exclude: rootDockerAssetExclude,
      platform: Platform.LINUX_ARM64,
    }),
    portMappings: [{ containerPort: 8080 }],
    // Full list of ECS env vars is also documented in .env.example
    environment: {
      AUTH_MODE: "cognito",
      HOSTNAME: "0.0.0.0",
      CORS_ORIGIN: `https://${props.appDomain}`,
      AUTH_DOMAIN: props.authDomain,
      COOKIE_DOMAIN: `.${props.appDomain.split(".").slice(1).join(".")}`,
      COGNITO_USER_POOL_ID: props.userPoolId,
      COGNITO_CLIENT_ID: props.userPoolClientId,
      COGNITO_REGION: cdk.Aws.REGION,
      DB_HOST: props.db.dbInstanceEndpointAddress,
      DB_NAME: "tracker",
      DB_USER: "app",
      // RDS certs are signed by Amazon's CA, not in the Node.js trust store.
      // Points to the CA bundle downloaded in apps/web/Dockerfile.
      NODE_EXTRA_CA_CERTS: "/app/rds-global-bundle.pem",
    },
    secrets: {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, "password"),
      SESSION_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.sessionEncryptionKeySecret),
      OPENAI_API_KEY: ecs.Secret.fromSecretsManager(props.openaiApiKeySecret),
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(props.anthropicApiKeySecret),
    },
    logging: ecs.LogDrivers.awsLogs({
      logGroup: webLogGroup,
      streamPrefix: "web",
    }),
    healthCheck: {
      command: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8080/api/live || exit 1"],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.seconds(60),
    },
  });

  // Near-zero-downtime rolling update: with the ECS defaults (minHealthyPercent=100%,
  // maxPercent=200%) a new task starts alongside the old one. ALB routes traffic to
  // both until the new task is live, then drains the old one (deregistration delay 300s).
  // Database readiness is checked separately after deploy, so schema changes must remain
  // backward-compatible for at least one rollout.
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

  // --- Auth Service ---
  const authTaskDef = new ecs.FargateTaskDefinition(scope, "AuthTask", {
    cpu: 256,
    memoryLimitMiB: 512,
    runtimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
  });

  const authLogGroup = new logs.LogGroup(scope, "AuthLogGroup", {
    logGroupName: "/expense-tracker/auth",
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  authTaskDef.addContainer("auth", {
    image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../.."), {
      file: "apps/auth/Dockerfile",
      exclude: rootDockerAssetExclude,
      platform: Platform.LINUX_ARM64,
    }),
    portMappings: [{ containerPort: 8081 }],
    environment: {
      PORT: "8081",
      COGNITO_CLIENT_ID: props.userPoolClientId,
      COGNITO_REGION: cdk.Aws.REGION,
      ALLOWED_REDIRECT_URIS: `https://${props.appDomain}`,
      COOKIE_DOMAIN: `.${props.appDomain.split(".").slice(1).join(".")}`,
      DB_HOST: props.db.dbInstanceEndpointAddress,
      DB_NAME: "tracker",
      DB_USER: "auth_service",
      NODE_EXTRA_CA_CERTS: "/app/rds-global-bundle.pem",
    },
    secrets: {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(props.authDbSecret, "password"),
      SESSION_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.sessionEncryptionKeySecret),
    },
    logging: ecs.LogDrivers.awsLogs({
      logGroup: authLogGroup,
      streamPrefix: "auth",
    }),
    healthCheck: {
      command: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8081/health || exit 1"],
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      retries: 3,
      startPeriod: cdk.Duration.seconds(60),
    },
  });

  const authService = new ecs.FargateService(scope, "AuthService", {
    cluster,
    taskDefinition: authTaskDef,
    desiredCount: 1,
    assignPublicIp: false,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.ecsSg],
    circuitBreaker: { enable: true },
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
      AUTH_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.authDbSecret, "password"),
      WORKER_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.workerDbSecret, "password"),
    },
    logging: ecs.LogDrivers.awsLogs({
      logGroup: migrateLogGroup,
      streamPrefix: "migrate",
    }),
  });

  return { cluster, webService, webContainer, authService, migrateTaskDef, migrateLogGroup };
}
