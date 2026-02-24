import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2_actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as elbv2_targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
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
    // Acceptable for a pet project where only the Lambda FX fetcher uses NAT
    // (a few KB/day). To switch to managed NAT Gateway, remove natGatewayProvider
    // and keep only: natGateways: 1,
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

    const ec2Sg = new ec2.SecurityGroup(this, "Ec2Sg", {
      vpc,
      description: "EC2: allow traffic from ALB",
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(3000), "ALB to web app");

    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "RDS: allow traffic from EC2 and Lambda",
    });
    dbSg.addIngressRule(ec2Sg, ec2.Port.tcp(5432), "EC2 to Postgres");

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

    // --- EC2 Instance (Docker Compose runtime) ---
    const ec2LogGroup = new logs.LogGroup(this, "Ec2LogGroup", {
      logGroupName: "/expense-tracker/ec2",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Shared Buildx install commands (used by UserData and SSM Deploy Document).
    // Version pinned to avoid GitHub API rate limits and unexpected upgrades during provisioning.
    const buildxVersion = "v0.21.0";
    const installBuildxCommands: ReadonlyArray<string> = [
      'ARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")',
      `BUILDX_VER="${buildxVersion}"`,
      'curl -SL "https://github.com/docker/buildx/releases/download/${BUILDX_VER}/buildx-${BUILDX_VER}.linux-${ARCH}" -o /usr/local/lib/docker/cli-plugins/docker-buildx',
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-buildx",
    ];

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "#!/bin/bash",
      "set -euo pipefail",
      // Install Docker + CloudWatch agent
      "dnf update -y",
      "dnf install -y docker git amazon-cloudwatch-agent",
      "systemctl enable docker && systemctl start docker",
      "usermod -aG docker ec2-user",
      // Configure CloudWatch agent for Docker logs
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWEOF'`,
      JSON.stringify({
        logs: {
          logs_collected: {
            files: {
              collect_list: [
                {
                  file_path: "/var/lib/docker/containers/*/*.log",
                  log_group_name: ec2LogGroup.logGroupName,
                  log_stream_name: "{instance_id}/docker",
                  timestamp_format: "%Y-%m-%dT%H:%M:%S",
                },
              ],
            },
          },
        },
      }),
      "CWEOF",
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json",
      // Install Docker Compose plugin + Buildx (compose v2 requires buildx 0.17+)
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      'curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose',
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      ...installBuildxCommands,
      // Clone repo and start
      "cd /home/ec2-user",
      `git clone https://github.com/${githubRepo}.git app`,
      "cd app",
      // Write .env from Secrets Manager (owner role for migrations, app role for web)
      `DB_SECRET=$(aws secretsmanager get-secret-value --secret-id expense-tracker/db-credentials --query SecretString --output text)`,
      `DB_USER=$(echo "$DB_SECRET" | python3 -c 'import sys,json; print(json.load(sys.stdin)["username"])')`,
      `DB_PASS=$(echo "$DB_SECRET" | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')`,
      `APP_PASS=$(aws secretsmanager get-secret-value --secret-id expense-tracker/app-db-password --query SecretString --output text | python3 -c 'import sys,json; print(json.load(sys.stdin)["password"])')`,
      `echo "MIGRATION_DATABASE_URL=postgresql://\${DB_USER}:\${DB_PASS}@${db.dbInstanceEndpointAddress}:5432/tracker?sslmode=require" > .env`,
      `echo "APP_DB_PASSWORD=\${APP_PASS}" >> .env`,
      `echo "DATABASE_URL=postgresql://app:\${APP_PASS}@${db.dbInstanceEndpointAddress}:5432/tracker" >> .env`,
      'echo "AUTH_MODE=proxy" >> .env',
      'echo "AUTH_PROXY_HEADER=x-amzn-oidc-data" >> .env',
      'echo "HOST=0.0.0.0" >> .env',
      `echo "CORS_ORIGIN=https://${appDomain}" >> .env`,
      `echo "COGNITO_DOMAIN=${authDomain}" >> .env`,
      `echo "COGNITO_CLIENT_ID=${userPoolClient.userPoolClientId}" >> .env`,
      // Run migrations (creates app role with APP_DB_PASSWORD) and start web
      // --env-file .env: compose project dir is infra/docker/ (from -f), but .env is at repo root
      // --no-deps: skip starting the postgres service (compose.yml defines it for local dev; on AWS we use RDS)
      "docker compose --env-file .env -f infra/docker/compose.yml run --no-deps --rm migrate",
      "docker compose --env-file .env -f infra/docker/compose.yml up --no-deps -d web",
      "chown -R ec2-user:ec2-user /home/ec2-user/app",
    );

    const ec2Role = new iam.Role(this, "Ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
      ],
    });
    db.secret?.grantRead(ec2Role);
    appDbSecret.grantRead(ec2Role);

    const instance = new ec2.Instance(this, "WebServer", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2Sg,
      userData,
      role: ec2Role,
    });

    // --- SSM Deploy Document (triggered by CI/CD to update app on EC2) ---
    const deployDocument = new ssm.CfnDocument(this, "DeployDocument", {
      documentType: "Command",
      updateMethod: "NewVersion",
      content: {
        schemaVersion: "2.2",
        description: "Pull latest code, build, migrate, and restart the app on EC2.",
        mainSteps: [
          {
            action: "aws:runShellScript",
            name: "deploy",
            inputs: {
              timeoutSeconds: "300",
              runCommand: [
                "set -euo pipefail",
                "cd /home/ec2-user/app",
                "",
                "# Install/upgrade Docker Buildx if missing or too old (compose v2 requires 0.17+)",
                'if ! docker buildx version 2>/dev/null | grep -qE "v0\\.(1[7-9]|[2-9][0-9])|v[1-9]"; then',
                '  echo "Installing Docker Buildx (need >= 0.17.0)..."',
                "  mkdir -p /usr/local/lib/docker/cli-plugins",
                ...installBuildxCommands.map((cmd: string) => `  ${cmd}`),
                '  echo "Buildx $(docker buildx version) installed."',
                "fi",
                "",
                "git pull origin main",
                "docker compose --env-file .env -f infra/docker/compose.yml build",
                "docker compose --env-file .env -f infra/docker/compose.yml run --no-deps --rm migrate",
                "docker compose --env-file .env -f infra/docker/compose.yml up --no-deps -d web",
                "",
                "# Wait for health check (up to 60s)",
                "for i in $(seq 1 30); do",
                "  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then",
                '    echo "Health check passed."',
                "    break",
                "  fi",
                '  if [ "$i" = "30" ]; then',
                '    echo "ERROR: Health check failed after 30 attempts"',
                "    docker compose --env-file .env -f infra/docker/compose.yml logs web",
                "    exit 1",
                "  fi",
                "  sleep 2",
                "done",
                "",
                'echo "Deploy complete."',
              ],
            },
          },
        ],
      },
    });

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
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2_targets.InstanceTarget(instance, 3000)],
      healthCheck: {
        path: "/api/health",
        interval: cdk.Duration.seconds(30),
      },
    });

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

    // EC2 CPU > 80%
    new cloudwatch.Alarm(this, "Ec2CpuAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName: "CPUUtilization",
        dimensionsMap: { InstanceId: instance.instanceId },
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: "EC2 CPU above 80% for 15 minutes",
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
                sid: "SsmSendDeploy",
                actions: ["ssm:SendCommand"],
                resources: [
                  `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:document/${deployDocument.ref}`,
                  `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/${instance.instanceId}`,
                ],
              }),
              new iam.PolicyStatement({
                sid: "SsmGetInvocation",
                actions: ["ssm:GetCommandInvocation"],
                // AWS does not support resource-level permissions for this action
                resources: ["*"],
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
    new cdk.CfnOutput(this, "Ec2LogGroupName", {
      value: ec2LogGroup.logGroupName,
      description: "CloudWatch log group for EC2 Docker logs",
    });
    new cdk.CfnOutput(this, "Ec2InstanceId", {
      value: instance.instanceId,
      description: "EC2 instance ID (for SSM deploy commands)",
    });
    new cdk.CfnOutput(this, "DeployDocumentName", {
      value: deployDocument.ref,
      description: "SSM Document name for EC2 app deployment",
    });
  }
}
