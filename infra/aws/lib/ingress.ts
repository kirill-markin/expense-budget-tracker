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
    removalPolicy: cdk.RemovalPolicy.RETAIN,
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
  // Rate limiting is intentionally NOT done here. All traffic arrives from Cloudflare
  // edge servers, so WAF sees Cloudflare IPs — not real client IPs. IP-based rate
  // limiting would group all clients behind the same Cloudflare PoP together,
  // making it both ineffective (attackers share the bucket with legitimate users)
  // and dangerous (could block an entire PoP).
  //
  // Rate limiting is covered by other layers:
  //   - Cloudflare: built-in DDoS protection, sees real client IPs natively.
  //   - Cognito: built-in throttling on auth endpoints (/oauth2/*).
  //   - ALB security group: only accepts traffic from Cloudflare edge IPs (networking.ts).
  //
  // WAF is kept for managed rule sets (SQLi, XSS, known bad inputs) which inspect
  // request content and work correctly regardless of source IP.
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
        name: "AWSManagedCommonRules",
        priority: 0,
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
        priority: 1,
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
