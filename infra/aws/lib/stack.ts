import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2_actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as backup from "aws-cdk-lib/aws-backup";
import { Construct } from "constructs";
import * as path from "path";

export class ExpenseBudgetTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Context parameters (domainName, certificateArn, region validated in bin/app.ts) ---
    const baseDomain = this.node.tryGetContext("domainName") as string;
    const alertEmail = this.node.tryGetContext("alertEmail") as string;
    const certificateArn = this.node.tryGetContext("certificateArn") as string;
    const githubRepo = this.node.tryGetContext("githubRepo") as string;

    const appDomain = `app.${baseDomain}`;
    const callbackUrl = `https://${appDomain}/oauth2/idpresponse`;

    // --- TLS Certificate (pre-created Cloudflare Origin Cert imported into ACM) ---
    const certificate = acm.Certificate.fromCertificateArn(
      this, "Certificate", certificateArn,
    );

    // --- VPC ---
    // NAT instance (t4g.nano ~$3/mo) instead of managed NAT Gateway (~$35/mo).
    // Trade-off: no HA, no auto-recovery, limited bandwidth (~5 Gbps burst).
    // Acceptable for a pet project where only the Lambda FX fetcher and ECS tasks use NAT
    // (a few KB/day + ECR image pulls). To switch to managed NAT Gateway, remove
    // natGatewayProvider and keep only: natGateways: 1,
    const natProvider = ec2.NatProvider.instanceV2({
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
    });
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGatewayProvider: natProvider,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // --- Security Groups ---
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "ALB: allow HTTP/HTTPS from internet",
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const ecsSg = new ec2.SecurityGroup(this, "EcsSg", {
      vpc,
      description: "ECS: allow traffic from ALB",
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(8080), "ALB to web app");

    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "RDS: allow traffic from ECS and Lambda",
    });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), "ECS to Postgres");

    const lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc,
      description: "Lambda: FX fetchers",
    });
    dbSg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), "Lambda to Postgres");

    // --- SNS Topic for alerts ---
    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: "expense-tracker-alerts",
    });
    alertTopic.addSubscription(
      new sns_subscriptions.EmailSubscription(alertEmail),
    );

    // --- Cognito User Pool ---
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "expense-tracker-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const authCertificateArn = this.node.tryGetContext("authCertificateArn") as string;
    const authDomain = `auth.${baseDomain}`;
    const authCertificate = acm.Certificate.fromCertificateArn(
      this, "AuthCertificate", authCertificateArn,
    );
    const userPoolDomain = userPool.addDomain("CognitoDomain", {
      customDomain: { domainName: authDomain, certificate: authCertificate },
    });

    const userPoolClient = userPool.addClient("AlbClient", {
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [callbackUrl],
        logoutUrls: [`https://${appDomain}/`],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    // --- RDS Postgres ---
    const dbCredentials = rds.Credentials.fromGeneratedSecret("tracker", {
      secretName: "expense-tracker/db-credentials",
    });

    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_18,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      credentials: dbCredentials,
      databaseName: "tracker",
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // --- App DB role secret ---
    const appDbSecret = new cdk.aws_secretsmanager.Secret(this, "AppDbSecret", {
      secretName: "expense-tracker/app-db-password",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "app" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // --- ECR Repositories ---
    const webRepo = new ecr.Repository(this, "WebRepo", {
      repositoryName: "expense-tracker/web",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const migrateRepo = new ecr.Repository(this, "MigrateRepo", {
      repositoryName: "expense-tracker/migrate",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5 }],
    });

    // --- ECS Cluster + Web Service ---
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const webTaskDef = new ecs.FargateTaskDefinition(this, "WebTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const webLogGroup = new logs.LogGroup(this, "WebLogGroup", {
      logGroupName: "/expense-tracker/web",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    webTaskDef.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(webRepo, "latest"),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        AUTH_MODE: "proxy",
        AUTH_PROXY_HEADER: "x-amzn-oidc-data",
        HOST: "0.0.0.0",
        CORS_ORIGIN: `https://${appDomain}`,
        COGNITO_DOMAIN: authDomain,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        DB_HOST: db.dbInstanceEndpointAddress,
        DB_NAME: "tracker",
        DB_USER: "app",
      },
      secrets: {
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: webLogGroup,
        streamPrefix: "web",
      }),
      healthCheck: {
        command: ["CMD-SHELL", "wget -qO- http://localhost:8080/api/health || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    const webService = new ecs.FargateService(this, "WebService", {
      cluster,
      taskDefinition: webTaskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [ecsSg],
    });

    // --- Migration Task Definition (one-off, not a service) ---
    const migrateTaskDef = new ecs.FargateTaskDefinition(this, "MigrateTask", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const migrateLogGroup = new logs.LogGroup(this, "MigrateLogGroup", {
      logGroupName: "/expense-tracker/migrate",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Migration needs the DB owner (tracker) credentials to run DDL + create the app role.
    migrateTaskDef.addContainer("migrate", {
      image: ecs.ContainerImage.fromEcrRepository(migrateRepo, "latest"),
      environment: {
        DB_HOST: db.dbInstanceEndpointAddress,
        DB_NAME: "tracker",
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(db.secret!, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, "password"),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: migrateLogGroup,
        streamPrefix: "migrate",
      }),
    });

    // Migration task runs in private subnets with access to RDS
    const migrateSg = new ec2.SecurityGroup(this, "MigrateSg", {
      vpc,
      description: "ECS migrate task: access to RDS",
    });
    dbSg.addIngressRule(migrateSg, ec2.Port.tcp(5432), "Migrate task to Postgres");

    // --- ALB ---
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    // S3 bucket for ALB access logs
    const accessLogsBucket = new s3.Bucket(this, "AlbAccessLogs", {
      bucketName: `expense-tracker-alb-logs-${cdk.Aws.ACCOUNT_ID}`,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
    });
    alb.logAccessLogs(accessLogsBucket);

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "WebTg", {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/api/health",
        interval: cdk.Duration.seconds(30),
      },
    });
    webService.attachToApplicationTargetGroup(targetGroup);

    // ALB listeners: HTTPS + Cognito auth, HTTP → HTTPS redirect
    const httpsListener = alb.addListener("HttpsListener", {
      port: 443,
      certificates: [certificate],
      defaultAction: new elbv2_actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });

    // Health check bypass: /api/health without auth
    httpsListener.addAction("HealthBypass", {
      priority: 1,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/api/health"])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Base domain → redirect to app subdomain (no container needed).
    // To serve your own site on the root domain, point its DNS elsewhere
    // and this rule becomes irrelevant.
    httpsListener.addAction("SiteRoute", {
      priority: 2,
      conditions: [elbv2.ListenerCondition.hostHeaders([baseDomain])],
      action: elbv2.ListenerAction.redirect({
        host: appDomain,
        permanent: false,
      }),
    });

    alb.addListener("HttpRedirect", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // --- AWS WAF ---
    const waf = new wafv2.CfnWebACL(this, "Waf", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "expense-tracker-waf",
      },
      rules: [
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "expense-tracker-rate-limit",
          },
        },
        {
          name: "AWSManagedCommonRules",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "expense-tracker-common-rules",
          },
        },
        {
          name: "AWSManagedKnownBadInputs",
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "expense-tracker-bad-inputs",
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, "WafAlbAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: waf.attrArn,
    });

    // --- CloudWatch Alarms ---
    // ALB 5xx errors
    new cloudwatch.Alarm(this, "Alb5xxAlarm", {
      metric: alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: "ALB returned 5+ server errors in 5 minutes",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // ECS CPU > 80% for 15 minutes
    new cloudwatch.Alarm(this, "EcsCpuAlarm", {
      metric: webService.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: "ECS CPU above 80% for 15 minutes",
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // ECS Memory > 80% for 15 minutes
    new cloudwatch.Alarm(this, "EcsMemoryAlarm", {
      metric: webService.metricMemoryUtilization({
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: "ECS memory above 80% for 15 minutes",
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // RDS DB connections > 80% of max (t4g.micro max ~85 connections)
    new cloudwatch.Alarm(this, "DbConnectionsAlarm", {
      metric: db.metricDatabaseConnections({
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 68,
      evaluationPeriods: 2,
      alarmDescription: "RDS connections above 80% capacity (68/85)",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // RDS free storage < 2 GB
    new cloudwatch.Alarm(this, "DbStorageAlarm", {
      metric: db.metricFreeStorageSpace({
        period: cdk.Duration.minutes(15),
        statistic: "Average",
      }),
      threshold: 2 * 1024 * 1024 * 1024,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: "RDS free storage below 2 GB",
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // --- Lambda (FX fetchers) ---
    const fxFetcher = new lambda_nodejs.NodejsFunction(this, "FxFetcher", {
      entry: path.join(__dirname, "../../../apps/worker/src/lambda.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {},
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Lambda FX fetcher errors
    new cloudwatch.Alarm(this, "FxLambdaErrorAlarm", {
      metric: fxFetcher.metricErrors({
        period: cdk.Duration.hours(1),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "FX fetcher Lambda had errors",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    appDbSecret.grantRead(fxFetcher);
    fxFetcher.addEnvironment("DB_SECRET_ARN", appDbSecret.secretArn);
    fxFetcher.addEnvironment("DB_HOST", db.dbInstanceEndpointAddress);
    fxFetcher.addEnvironment("DB_NAME", "tracker");

    // EventBridge: daily at 08:00 UTC
    new events.Rule(this, "FxSchedule", {
      schedule: events.Schedule.cron({ hour: "8", minute: "0" }),
      targets: [new events_targets.LambdaFunction(fxFetcher)],
    });

    // --- GitHub Actions OIDC (CI/CD) ---
    {
      const oidcProvider = new iam.OpenIdConnectProvider(this, "GithubOidc", {
        url: "https://token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
      });

      const deployRole = new iam.Role(this, "GithubActionsRole", {
        roleName: "expense-tracker-github-deploy",
        assumedBy: new iam.WebIdentityPrincipal(
          oidcProvider.openIdConnectProviderArn,
          {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            },
            StringLike: {
              "token.actions.githubusercontent.com:sub": `repo:${githubRepo}:ref:refs/heads/main`,
            },
          },
        ),
        inlinePolicies: {
          CdkDeploy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                sid: "AssumeCdkRoles",
                actions: ["sts:AssumeRole"],
                resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`],
              }),
              new iam.PolicyStatement({
                sid: "ReadStackOutputs",
                actions: ["cloudformation:DescribeStacks"],
                resources: [this.stackId],
              }),
              new iam.PolicyStatement({
                sid: "EcrPush",
                actions: [
                  "ecr:GetAuthorizationToken",
                  "ecr:BatchCheckLayerAvailability",
                  "ecr:GetDownloadUrlForLayer",
                  "ecr:BatchGetImage",
                  "ecr:PutImage",
                  "ecr:InitiateLayerUpload",
                  "ecr:UploadLayerPart",
                  "ecr:CompleteLayerUpload",
                ],
                resources: [webRepo.repositoryArn, migrateRepo.repositoryArn],
              }),
              new iam.PolicyStatement({
                sid: "EcrLogin",
                actions: ["ecr:GetAuthorizationToken"],
                resources: ["*"],
              }),
              new iam.PolicyStatement({
                sid: "EcsDeploy",
                actions: [
                  "ecs:RunTask",
                  "ecs:DescribeTasks",
                  "ecs:UpdateService",
                  "ecs:DescribeServices",
                ],
                resources: ["*"],
              }),
              new iam.PolicyStatement({
                sid: "PassEcsRoles",
                actions: ["iam:PassRole"],
                resources: [
                  webTaskDef.taskRole.roleArn,
                  webTaskDef.executionRole!.roleArn,
                  migrateTaskDef.taskRole.roleArn,
                  migrateTaskDef.executionRole!.roleArn,
                ],
              }),
              new iam.PolicyStatement({
                sid: "EcsWaitLogs",
                actions: [
                  "logs:GetLogEvents",
                  "logs:FilterLogEvents",
                ],
                resources: [
                  migrateLogGroup.logGroupArn,
                  `${migrateLogGroup.logGroupArn}:*`,
                ],
              }),
            ],
          }),
        },
      });

      new cdk.CfnOutput(this, "GithubDeployRoleArn", {
        value: deployRole.roleArn,
        description: "IAM role ARN for GitHub Actions deployment",
      });
    }

    // --- AWS Backup ---
    const backupPlan = backup.BackupPlan.daily35DayRetention(this, "BackupPlan");
    backupPlan.addSelection("DbBackup", {
      resources: [backup.BackupResource.fromRdsDatabaseInstance(db)],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "AppUrl", {
      value: `https://${appDomain}`,
      description: "Application URL (base domain redirects here)",
    });
    new cdk.CfnOutput(this, "AlbDns", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name",
    });
    new cdk.CfnOutput(this, "DbEndpoint", {
      value: db.dbInstanceEndpointAddress,
      description: "RDS endpoint (private)",
    });
    new cdk.CfnOutput(this, "DbSecretArn", {
      value: db.secret?.secretArn ?? "N/A",
      description: "Secrets Manager ARN for DB owner credentials",
    });
    new cdk.CfnOutput(this, "AppDbSecretArn", {
      value: appDbSecret.secretArn,
      description: "Secrets Manager ARN for app role credentials",
    });
    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID — create users here",
    });
    new cdk.CfnOutput(this, "CognitoDomain", {
      value: userPoolDomain.domainName,
      description: "Cognito hosted UI domain prefix",
    });
    new cdk.CfnOutput(this, "AlertTopicArn", {
      value: alertTopic.topicArn,
      description: "SNS topic for alerts",
    });
    new cdk.CfnOutput(this, "AccessLogsBucket", {
      value: accessLogsBucket.bucketName,
      description: "S3 bucket for ALB access logs",
    });
    new cdk.CfnOutput(this, "WebRepoUri", {
      value: webRepo.repositoryUri,
      description: "ECR repository URI for web image",
    });
    new cdk.CfnOutput(this, "MigrateRepoUri", {
      value: migrateRepo.repositoryUri,
      description: "ECR repository URI for migrate image",
    });
    new cdk.CfnOutput(this, "EcsClusterName", {
      value: cluster.clusterName,
      description: "ECS cluster name",
    });
    new cdk.CfnOutput(this, "EcsServiceName", {
      value: webService.serviceName,
      description: "ECS web service name",
    });
    new cdk.CfnOutput(this, "MigrateTaskDefArn", {
      value: migrateTaskDef.taskDefinitionArn,
      description: "ECS task definition ARN for migrations",
    });
    new cdk.CfnOutput(this, "MigrateSecurityGroupId", {
      value: migrateSg.securityGroupId,
      description: "Security group ID for migration tasks",
    });
  }
}
