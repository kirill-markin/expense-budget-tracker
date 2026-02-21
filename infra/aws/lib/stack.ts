import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2_actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as elbv2_targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class ExpenseBudgetTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Context parameters ---
    const domainName = this.node.tryGetContext("domainName") as string | undefined;
    const certificateArn = this.node.tryGetContext("certificateArn") as string | undefined;
    const keyPairName = this.node.tryGetContext("keyPairName") as string | undefined;
    const callbackUrl = domainName ? `https://${domainName}/oauth2/idpresponse` : undefined;

    // --- VPC ---
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
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

    // --- Cognito User Pool ---
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "expense-tracker-users",
      selfSignUpEnabled: false,
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

    const userPoolDomain = userPool.addDomain("CognitoDomain", {
      cognitoDomain: {
        domainPrefix: `expense-tracker-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    const userPoolClient = userPool.addClient("AlbClient", {
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: callbackUrl
          ? [callbackUrl]
          : [`https://${cdk.Aws.REGION}.elb.amazonaws.com/oauth2/idpresponse`],
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
        version: rds.PostgresEngineVersion.VER_16,
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
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // --- EC2 Instance (Docker Compose runtime) ---
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "#!/bin/bash",
      "set -euo pipefail",
      // Install Docker
      "dnf update -y",
      "dnf install -y docker git",
      "systemctl enable docker && systemctl start docker",
      "usermod -aG docker ec2-user",
      // Install Docker Compose plugin
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      'curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose',
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      // Clone repo and start
      "cd /home/ec2-user",
      "git clone https://github.com/kirill-markin/expense-budget-tracker.git app",
      "cd app",
      // Write .env from Secrets Manager
      `echo "DATABASE_URL=$(aws secretsmanager get-secret-value --secret-id expense-tracker/db-credentials --query SecretString --output text | python3 -c 'import sys,json; s=json.load(sys.stdin); print(f"postgresql://{s[\\"username\\"]}:{s[\\"password\\"]}@${db.dbInstanceEndpointAddress}:5432/tracker")')" > .env`,
      'echo "AUTH_MODE=proxy" >> .env',
      'echo "AUTH_PROXY_HEADER=x-amzn-oidc-data" >> .env',
      'echo "HOST=0.0.0.0" >> .env',
      'echo "CORS_ORIGIN=*" >> .env',
      // Run migrations and start web
      "docker compose -f infra/docker/compose.yml up -d postgres",
      "sleep 5",
      "docker compose -f infra/docker/compose.yml run --rm migrate",
      "docker compose -f infra/docker/compose.yml up -d web",
    );

    const ec2Role = new iam.Role(this, "Ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    db.secret?.grantRead(ec2Role);

    const instance = new ec2.Instance(this, "WebServer", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2Sg,
      userData,
      role: ec2Role,
      keyPair: keyPairName
        ? ec2.KeyPair.fromKeyPairName(this, "KeyPair", keyPairName)
        : undefined,
    });

    // --- ALB ---
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

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

    // ALB listeners with Cognito auth
    if (certificateArn) {
      const httpsListener = alb.addListener("HttpsListener", {
        port: 443,
        certificates: [
          elbv2.ListenerCertificate.fromArn(certificateArn),
        ],
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

      alb.addListener("HttpRedirect", {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
    } else {
      // No certificate: HTTP only, no Cognito auth (dev/testing)
      alb.addListener("HttpListener", {
        port: 80,
        defaultTargetGroups: [targetGroup],
      });
    }

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
        // Rate limiting: 1000 requests per 5 minutes per IP
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
        // AWS Managed Rules: common threats
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
        // AWS Managed Rules: known bad inputs (SQLi, XSS)
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

    // Associate WAF with ALB
    new wafv2.CfnWebACLAssociation(this, "WafAlbAssociation", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: waf.attrArn,
    });

    // --- Lambda (FX fetchers) ---
    const fxFetcher = new lambda.Function(this, "FxFetcher", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "lambda_handler.handler",
      code: lambda.Code.fromAsset("../../apps/worker"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        DATABASE_URL: "placeholder",
      },
    });

    // Grant Lambda access to DB secret and set DATABASE_URL at deploy
    if (db.secret) {
      db.secret.grantRead(fxFetcher);
      fxFetcher.addEnvironment("DB_SECRET_ARN", db.secret.secretArn);
      fxFetcher.addEnvironment("DB_HOST", db.dbInstanceEndpointAddress);
      fxFetcher.addEnvironment("DB_NAME", "tracker");
    }

    // EventBridge: daily at 08:00 UTC
    new events.Rule(this, "FxSchedule", {
      schedule: events.Schedule.cron({ hour: "8", minute: "0" }),
      targets: [new events_targets.LambdaFunction(fxFetcher)],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "AlbDns", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name — point your domain CNAME here",
    });
    new cdk.CfnOutput(this, "DbEndpoint", {
      value: db.dbInstanceEndpointAddress,
      description: "RDS endpoint (private)",
    });
    new cdk.CfnOutput(this, "DbSecretArn", {
      value: db.secret?.secretArn ?? "N/A",
      description: "Secrets Manager ARN for DB credentials",
    });
    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID — create users here",
    });
    new cdk.CfnOutput(this, "CognitoDomain", {
      value: userPoolDomain.domainName,
      description: "Cognito hosted UI domain prefix",
    });
  }
}
