import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface IngressProps {
  vpc: ec2.Vpc;
  albSg: ec2.SecurityGroup;
  certificate: acm.ICertificate;
  webService: ecs.FargateService;
  authService: ecs.FargateService;
  baseDomain: string;
  appDomain: string;
  authDomain: string;
}

export interface IngressResult {
  alb: elbv2.ApplicationLoadBalancer;
  accessLogsBucket: s3.Bucket;
}

type ByteMatchPositionalConstraint = "EXACTLY" | "STARTS_WITH";

const noneTextTransformation = (): wafv2.CfnWebACL.TextTransformationProperty => ({
  priority: 0,
  type: "NONE",
});

const lowercaseTextTransformation = (): wafv2.CfnWebACL.TextTransformationProperty => ({
  priority: 0,
  type: "LOWERCASE",
});

const byteMatchStatement = (
  fieldToMatch: wafv2.CfnWebACL.FieldToMatchProperty,
  positionalConstraint: ByteMatchPositionalConstraint,
  searchString: string,
  textTransformation: wafv2.CfnWebACL.TextTransformationProperty,
): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch,
    positionalConstraint,
    searchString,
    textTransformations: [textTransformation],
  },
});

const methodIs = (method: string): wafv2.CfnWebACL.StatementProperty =>
  byteMatchStatement({ method: {} }, "EXACTLY", method, noneTextTransformation());

const uriPathIs = (path: string): wafv2.CfnWebACL.StatementProperty =>
  byteMatchStatement({ uriPath: {} }, "EXACTLY", path, noneTextTransformation());

const singleHeaderField = (headerName: string): wafv2.CfnWebACL.FieldToMatchProperty => ({
  singleHeader: { Name: headerName },
});

const headerIs = (
  headerName: string,
  headerValue: string,
): wafv2.CfnWebACL.StatementProperty =>
  byteMatchStatement(
    singleHeaderField(headerName),
    "EXACTLY",
    headerValue.toLowerCase(),
    lowercaseTextTransformation(),
  );

const headerStartsWith = (
  headerName: string,
  headerPrefix: string,
): wafv2.CfnWebACL.StatementProperty =>
  byteMatchStatement(
    singleHeaderField(headerName),
    "STARTS_WITH",
    headerPrefix.toLowerCase(),
    lowercaseTextTransformation(),
  );

const hasLabel = (label: string): wafv2.CfnWebACL.StatementProperty => ({
  labelMatchStatement: {
    scope: "LABEL",
    key: label,
  },
});

const andStatement = (
  statements: ReadonlyArray<wafv2.CfnWebACL.StatementProperty>,
): wafv2.CfnWebACL.StatementProperty => ({
  andStatement: {
    statements: [...statements],
  },
});

const orStatement = (
  statements: ReadonlyArray<wafv2.CfnWebACL.StatementProperty>,
): wafv2.CfnWebACL.StatementProperty => ({
  orStatement: {
    statements: [...statements],
  },
});

const notStatement = (
  statement: wafv2.CfnWebACL.StatementProperty,
): wafv2.CfnWebACL.StatementProperty => ({
  notStatement: {
    statement,
  },
});

const blockLabeledRequestUnless = (
  name: string,
  priority: number,
  label: string,
  allowedRequest: wafv2.CfnWebACL.StatementProperty,
  metricName: string,
): wafv2.CfnWebACL.RuleProperty => ({
  name,
  priority,
  action: { block: {} },
  statement: andStatement([
    hasLabel(label),
    notStatement(allowedRequest),
  ]),
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName,
  },
});

const postRequestToApp = (
  appDomain: string,
  path: string,
  contentTypePrefix: string,
): wafv2.CfnWebACL.StatementProperty =>
  andStatement([
    methodIs("POST"),
    uriPathIs(path),
    headerIs("host", appDomain),
    headerIs("origin", `https://${appDomain}`),
    headerStartsWith("content-type", contentTypePrefix),
  ]);

export function ingress(scope: Construct, props: IngressProps): IngressResult {
  // --- ALB ---
  const alb = new elbv2.ApplicationLoadBalancer(scope, "Alb", {
    vpc: props.vpc,
    internetFacing: true,
    securityGroup: props.albSg,
  });
  alb.setAttribute("idle_timeout.timeout_seconds", "600");

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
      path: "/api/live",
      interval: cdk.Duration.seconds(30),
    },
  });
  props.webService.attachToApplicationTargetGroup(targetGroup);

  // ALB listeners: HTTPS forwards to app, HTTP → HTTPS redirect
  const httpsListener = alb.addListener("HttpsListener", {
    port: 443,
    certificates: [props.certificate],
    defaultAction: elbv2.ListenerAction.forward([targetGroup]),
  });

  // Auth service target group (port 8081)
  const authTargetGroup = new elbv2.ApplicationTargetGroup(scope, "AuthTg", {
    vpc: props.vpc,
    port: 8081,
    protocol: elbv2.ApplicationProtocol.HTTP,
    targetType: elbv2.TargetType.IP,
    healthCheck: {
      path: "/health",
      interval: cdk.Duration.seconds(30),
    },
  });
  props.authService.attachToApplicationTargetGroup(authTargetGroup);

  // auth.* → forward to auth service
  httpsListener.addAction("AuthRoute", {
    priority: 10,
    conditions: [elbv2.ListenerCondition.hostHeaders([props.authDomain])],
    action: elbv2.ListenerAction.forward([authTargetGroup]),
  });

  // Base domain → redirect to app subdomain (no container needed).
  // To serve your own site on the root domain, point its DNS elsewhere
  // and this rule becomes irrelevant.
  httpsListener.addAction("SiteRoute", {
    priority: 20,
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
  // Rate limiting is intentionally NOT done here. Default aggregateKeyType "IP" sees
  // Cloudflare edge IPs, not real clients — useless behind a reverse proxy.
  // FORWARDED_IP with CF-Connecting-IP header would work (ALB SG guarantees only
  // Cloudflare can set it), but rate limiting is already handled by other layers:
  //   - Cloudflare: DDoS protection + rate limiting rules, sees real IPs natively.
  //   - Cognito: built-in throttling on auth endpoints (/oauth2/*).
  //   - ALB security group: only accepts Cloudflare edge IPs (networking.ts).
  //
  // WAF is kept for managed rule sets (SQLi, XSS, known bad inputs) which inspect
  // request content and work correctly regardless of source IP.
  const chatJsonRequest = postRequestToApp(props.appDomain, "/api/chat", "application/json");
  const chatTranscriptionUploadRequest = postRequestToApp(
    props.appDomain,
    "/api/chat/transcriptions",
    "multipart/form-data",
  );

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
            ruleActionOverrides: [
              {
                name: "CrossSiteScripting_BODY",
                actionToUse: { count: {} },
              },
              // SizeRestrictions_BODY blocks requests with body > 8 KB.
              // Large app payloads are re-blocked below except for explicit upload routes.
              {
                name: "SizeRestrictions_BODY",
                actionToUse: { count: {} },
              },
            ],
          },
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: "expense-tracker-common-rules",
        },
      },
      blockLabeledRequestUnless(
        "BlockUnexpectedXssBodyMatches",
        1,
        "awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body",
        chatTranscriptionUploadRequest,
        "expense-tracker-xss-body-reblock",
      ),
      blockLabeledRequestUnless(
        "BlockUnexpectedBodySizeMatches",
        2,
        "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body",
        orStatement([chatJsonRequest, chatTranscriptionUploadRequest]),
        "expense-tracker-size-body-reblock",
      ),
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
