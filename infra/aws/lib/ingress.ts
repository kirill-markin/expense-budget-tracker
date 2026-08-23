import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import {
  MAX_OAUTH_AUTHORIZE_QUERY_BYTES,
  MAX_OAUTH_LOGIN_QUERY_BYTES,
} from "@expense-budget-tracker/agent-shared";

export interface IngressProps {
  vpc: ec2.Vpc;
  albSg: ec2.SecurityGroup;
  certificate: acm.ICertificate;
  webService: ecs.FargateService;
  authService: ecs.FargateService;
  baseDomain: string;
  appDomain: string;
  authDomain: string;
  originSharedSecret: string;
}

export interface IngressResult {
  alb: elbv2.ApplicationLoadBalancer;
  accessLogsBucket: s3.Bucket;
  webTargetGroup: elbv2.ApplicationTargetGroup;
  webAclName: string;
}

type ByteMatchPositionalConstraint = "EXACTLY" | "STARTS_WITH";

// AWS WAF's smallest native rate envelope is 10 requests over 60 seconds.
const DYNAMIC_CLIENT_REGISTRATION_RATE_LIMIT = 10;
const DYNAMIC_CLIENT_REGISTRATION_EVALUATION_WINDOW_SECONDS = 60;
const OAUTH_TOKEN_EXCHANGE_RATE_LIMIT = 60;
const OAUTH_TOKEN_EXCHANGE_EVALUATION_WINDOW_SECONDS = 60;

// Injected by a Transform Rule in our own Cloudflare zone. AWS WAF singleHeader
// names must be lowercase. Requests reaching the ALB through any other Cloudflare
// zone cannot carry it, so they are rejected once the secret is configured.
const ORIGIN_SHARED_SECRET_HEADER = "x-origin-auth";
// Priorities 0-8 are taken and AWS WAF priorities are non-negative integers, so the
// lowest free slot is after the rate-based rules. Evaluation order is irrelevant for
// this rule because the rate limiters scope themselves down to requests carrying the
// same secret, so a foreign-zone request is never aggregated before it is blocked.
const ORIGIN_SHARED_SECRET_RULE_PRIORITY = 9;

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

const querySizeAtMost = (maxBytes: number): wafv2.CfnWebACL.StatementProperty => ({
  sizeConstraintStatement: {
    comparisonOperator: "LE",
    fieldToMatch: { queryString: {} },
    size: maxBytes,
    textTransformations: [noneTextTransformation()],
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

const originSharedSecretMatches = (
  originSharedSecret: string,
): wafv2.CfnWebACL.StatementProperty =>
  byteMatchStatement(
    singleHeaderField(ORIGIN_SHARED_SECRET_HEADER),
    "EXACTLY",
    originSharedSecret,
    noneTextTransformation(),
  );

// Blocks every request whose origin secret header is absent or different.
// A missing header does not match the byte comparison, so the negation matches.
const blockRequestsWithoutOriginSharedSecret = (
  originSharedSecret: string,
): wafv2.CfnWebACL.RuleProperty => ({
  name: "BlockRequestsWithoutOriginSharedSecret",
  priority: ORIGIN_SHARED_SECRET_RULE_PRIORITY,
  action: { block: {} },
  statement: notStatement(originSharedSecretMatches(originSharedSecret)),
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "expense-tracker-origin-secret-block",
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

export const buildIngressWafRules = (
  appDomain: string,
  authDomain: string,
  originSharedSecret: string,
): ReadonlyArray<wafv2.CfnWebACL.RuleProperty> => {
  // A blank or whitespace-only context value means "not configured": it must leave
  // the web ACL untouched instead of producing a live rule matching a literal that
  // Cloudflare never sends. Padding around a real secret is stripped for the same
  // reason, so the rule always matches exactly what the Transform Rule injects.
  const sharedSecret = originSharedSecret.trim();

  // Rate-based rules aggregate every request they evaluate, and a terminating action
  // in a later rule does not un-count it. A request that did not come through our
  // Cloudflare zone therefore must never enter a CF-Connecting-IP rate-limit scope,
  // or a forged CF-Connecting-IP can still exhaust a victim IP's budget before the
  // origin-secret rule blocks it. Requiring the secret inside every scope-down keeps
  // the rate limits keyed on IPs we actually trust, without renumbering any rule.
  const fromTrustedZone: ReadonlyArray<wafv2.CfnWebACL.StatementProperty> =
    sharedSecret === "" ? [] : [originSharedSecretMatches(sharedSecret)];

  const chatJsonRequest = postRequestToApp(appDomain, "/api/chat", "application/json");
  const newChatJsonRequest = postRequestToApp(
    appDomain,
    "/api/chat/new",
    "application/json",
  );
  const chatTranscriptionUploadRequest = postRequestToApp(
    appDomain,
    "/api/chat/transcriptions",
    "multipart/form-data",
  );
  const dynamicClientRegistrationJsonRequest = andStatement([
    headerIs("host", authDomain),
    methodIs("POST"),
    uriPathIs("/oauth/register"),
    headerStartsWith("content-type", "application/json"),
  ]);
  const boundedOAuthQueryRequest = orStatement([
    andStatement([
      methodIs("GET"),
      headerIs("host", authDomain),
      uriPathIs("/oauth/authorize"),
      querySizeAtMost(MAX_OAUTH_AUTHORIZE_QUERY_BYTES),
    ]),
    andStatement([
      methodIs("GET"),
      headerIs("host", authDomain),
      uriPathIs("/login"),
      querySizeAtMost(MAX_OAUTH_LOGIN_QUERY_BYTES),
    ]),
  ]);

  const rules: ReadonlyArray<wafv2.CfnWebACL.RuleProperty> = [
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
            // OAuth authorization queries can exceed the managed 2 KiB threshold.
            // Exact bounded auth routes are allowed and all other matches are re-blocked.
            {
              name: "SizeRestrictions_QUERYSTRING",
              actionToUse: { count: {} },
            },
            // Native OAuth clients legitimately register loopback redirect URIs.
            // Exact JSON registration requests are allowed and all other matches are re-blocked.
            {
              name: "EC2MetaDataSSRF_BODY",
              actionToUse: { count: {} },
            },
            {
              name: "GenericRFI_BODY",
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
      orStatement([chatJsonRequest, newChatJsonRequest, chatTranscriptionUploadRequest]),
      "expense-tracker-size-body-reblock",
    ),
    blockLabeledRequestUnless(
      "BlockUnexpectedQuerySizeMatches",
      3,
      "awswaf:managed:aws:core-rule-set:SizeRestrictions_QueryString",
      boundedOAuthQueryRequest,
      "expense-tracker-size-query-reblock",
    ),
    blockLabeledRequestUnless(
      "BlockUnexpectedEc2MetadataSsrfBodyMatches",
      4,
      "awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body",
      dynamicClientRegistrationJsonRequest,
      "expense-tracker-ec2-metadata-ssrf-body-reblock",
    ),
    blockLabeledRequestUnless(
      "BlockUnexpectedGenericRfiBodyMatches",
      5,
      "awswaf:managed:aws:core-rule-set:GenericRFI_Body",
      dynamicClientRegistrationJsonRequest,
      "expense-tracker-generic-rfi-body-reblock",
    ),
    {
      name: "AWSManagedKnownBadInputs",
      priority: 6,
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
    {
      name: "RateLimitDynamicClientRegistration",
      priority: 7,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          aggregateKeyType: "FORWARDED_IP",
          evaluationWindowSec: DYNAMIC_CLIENT_REGISTRATION_EVALUATION_WINDOW_SECONDS,
          forwardedIpConfig: {
            headerName: "CF-Connecting-IP",
            fallbackBehavior: "MATCH",
          },
          limit: DYNAMIC_CLIENT_REGISTRATION_RATE_LIMIT,
          scopeDownStatement: andStatement([
            headerIs("host", authDomain),
            methodIs("POST"),
            uriPathIs("/oauth/register"),
            ...fromTrustedZone,
          ]),
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "expense-tracker-dcr-rate-limit",
      },
    },
    {
      name: "RateLimitOAuthTokenExchanges",
      priority: 8,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          aggregateKeyType: "FORWARDED_IP",
          evaluationWindowSec: OAUTH_TOKEN_EXCHANGE_EVALUATION_WINDOW_SECONDS,
          forwardedIpConfig: {
            headerName: "CF-Connecting-IP",
            fallbackBehavior: "MATCH",
          },
          limit: OAUTH_TOKEN_EXCHANGE_RATE_LIMIT,
          scopeDownStatement: andStatement([
            headerIs("host", authDomain),
            methodIs("POST"),
            uriPathIs("/oauth/token"),
            ...fromTrustedZone,
          ]),
        },
      },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "expense-tracker-oauth-token-rate-limit",
      },
    },
  ];

  if (sharedSecret === "") {
    return rules;
  }

  return [...rules, blockRequestsWithoutOriginSharedSecret(sharedSecret)];
};

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

  const webTargetGroup = new elbv2.ApplicationTargetGroup(scope, "WebTg", {
    vpc: props.vpc,
    port: 8080,
    protocol: elbv2.ApplicationProtocol.HTTP,
    targetType: elbv2.TargetType.IP,
    healthCheck: {
      path: "/api/live",
      interval: cdk.Duration.seconds(30),
    },
  });
  props.webService.attachToApplicationTargetGroup(webTargetGroup);

  // ALB listeners: HTTPS forwards to app, HTTP → HTTPS redirect.
  // open: false on every listener. The CDK default (open: true) adds an anyIpv4
  // ingress rule for the listener port to the ALB security group, which reopens the
  // load balancer to the whole internet next to the Cloudflare-only rules built in
  // networking.ts. Bypassing Cloudflare that way defeats every Cloudflare-side
  // control and the WAF rate limits keyed on CF-Connecting-IP.
  const httpsListener = alb.addListener("HttpsListener", {
    port: 443,
    open: false,
    certificates: [props.certificate],
    defaultAction: elbv2.ListenerAction.forward([webTargetGroup]),
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
    open: false,
    defaultAction: elbv2.ListenerAction.redirect({
      protocol: "HTTPS",
      port: "443",
      permanent: true,
    }),
  });

  // --- AWS WAF ---
  // The ALB security group accepts only Cloudflare edges, so CF-Connecting-IP is
  // the trusted real-client boundary for the OAuth rate rules. AWS WAF ignores these
  // rules if that header is absent; Cloudflare supplies it on every origin request.
  // A present malformed value uses MATCH and is blocked instead of bypassing a rule.
  // "Some Cloudflare edge" is a weaker claim than "our Cloudflare zone": once
  // originSharedSecret is configured, the rate rules additionally require the
  // x-origin-auth header, so only requests from our own zone are ever aggregated.
  const waf = new wafv2.CfnWebACL(scope, "Waf", {
    scope: "REGIONAL",
    defaultAction: { allow: {} },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: "expense-tracker-waf",
    },
    rules: [
      ...buildIngressWafRules(
        props.appDomain,
        props.authDomain,
        props.originSharedSecret,
      ),
    ],
  });
  const webAclName = cdk.Fn.select(0, cdk.Fn.split("|", waf.ref));

  new wafv2.CfnWebACLAssociation(scope, "WafAlbAssociation", {
    resourceArn: alb.loadBalancerArn,
    webAclArn: waf.attrArn,
  });

  return { alb, accessLogsBucket, webTargetGroup, webAclName };
}
