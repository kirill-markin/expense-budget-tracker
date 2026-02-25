import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2_actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface IngressProps {
  vpc: ec2.Vpc;
  albSg: ec2.SecurityGroup;
  certificate: acm.ICertificate;
  webService: ecs.FargateService;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  userPoolDomain: cognito.UserPoolDomain;
  baseDomain: string;
  appDomain: string;
}

export interface IngressResult {
  alb: elbv2.ApplicationLoadBalancer;
  accessLogsBucket: s3.Bucket;
}

export function ingress(scope: Construct, props: IngressProps): IngressResult {
  // --- ALB ---
  const alb = new elbv2.ApplicationLoadBalancer(scope, "Alb", {
    vpc: props.vpc,
    internetFacing: true,
    securityGroup: props.albSg,
  });

  // S3 bucket for ALB access logs
  const accessLogsBucket = new s3.Bucket(scope, "AlbAccessLogs", {
    bucketName: `expense-tracker-alb-logs-${cdk.Aws.ACCOUNT_ID}`,
    lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    enforceSSL: true,
  });
  alb.logAccessLogs(accessLogsBucket);

  const targetGroup = new elbv2.ApplicationTargetGroup(scope, "WebTg", {
    vpc: props.vpc,
    port: 8080,
    protocol: elbv2.ApplicationProtocol.HTTP,
    targetType: elbv2.TargetType.IP,
    healthCheck: {
      path: "/api/health",
      interval: cdk.Duration.seconds(30),
    },
  });
  props.webService.attachToApplicationTargetGroup(targetGroup);

  // ALB listeners: HTTPS + Cognito auth, HTTP → HTTPS redirect
  const httpsListener = alb.addListener("HttpsListener", {
    port: 443,
    certificates: [props.certificate],
    defaultAction: new elbv2_actions.AuthenticateCognitoAction({
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      userPoolDomain: props.userPoolDomain,
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
    conditions: [elbv2.ListenerCondition.hostHeaders([props.baseDomain])],
    action: elbv2.ListenerAction.redirect({
      host: props.appDomain,
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
  const waf = new wafv2.CfnWebACL(scope, "Waf", {
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

  new wafv2.CfnWebACLAssociation(scope, "WafAlbAssociation", {
    resourceArn: alb.loadBalancerArn,
    webAclArn: waf.attrArn,
  });

  return { alb, accessLogsBucket };
}
