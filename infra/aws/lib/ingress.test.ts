import assert from "node:assert/strict";
import test from "node:test";
import type { IResolvable } from "aws-cdk-lib";
import type * as wafv2 from "aws-cdk-lib/aws-wafv2";
import {
  MAX_OAUTH_AUTHORIZE_QUERY_BYTES,
  MAX_OAUTH_LOGIN_QUERY_BYTES,
} from "@expense-budget-tracker/agent-shared";
import { buildIngressWafRules } from "./ingress";

const getRule = (
  rules: ReadonlyArray<wafv2.CfnWebACL.RuleProperty>,
  name: string,
): wafv2.CfnWebACL.RuleProperty => {
  const rule = rules.find((candidate) => candidate.name === name);
  if (rule === undefined) throw new Error(`Expected WAF rule ${name}`);
  return rule;
};

const requireStatement = (
  statement: IResolvable | wafv2.CfnWebACL.StatementProperty | undefined,
): wafv2.CfnWebACL.StatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF statement");
  }
  return statement;
};

const requireStatements = (
  statements:
    | Array<IResolvable | wafv2.CfnWebACL.StatementProperty>
    | IResolvable
    | undefined,
): ReadonlyArray<wafv2.CfnWebACL.StatementProperty> => {
  if (!Array.isArray(statements)) {
    throw new Error("Expected inline WAF statements");
  }
  return statements.map(requireStatement);
};

const requireRuleActionOverrides = (
  overrides:
    | Array<IResolvable | wafv2.CfnWebACL.RuleActionOverrideProperty>
    | IResolvable
    | undefined,
): ReadonlyArray<wafv2.CfnWebACL.RuleActionOverrideProperty> => {
  if (!Array.isArray(overrides)) {
    throw new Error("Expected inline WAF rule action overrides");
  }
  return overrides.map((override) => {
    if ("resolve" in override) {
      throw new Error("Expected an inline WAF rule action override");
    }
    return override;
  });
};

const requireRateBasedStatement = (
  statement: IResolvable | wafv2.CfnWebACL.RateBasedStatementProperty | undefined,
): wafv2.CfnWebACL.RateBasedStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF rate-based statement");
  }
  return statement;
};

const requireAndStatement = (
  statement: IResolvable | wafv2.CfnWebACL.AndStatementProperty | undefined,
): wafv2.CfnWebACL.AndStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF and statement");
  }
  return statement;
};

const requireOrStatement = (
  statement: IResolvable | wafv2.CfnWebACL.OrStatementProperty | undefined,
): wafv2.CfnWebACL.OrStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF or statement");
  }
  return statement;
};

const requireNotStatement = (
  statement: IResolvable | wafv2.CfnWebACL.NotStatementProperty | undefined,
): wafv2.CfnWebACL.NotStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF not statement");
  }
  return statement;
};

const requireByteMatchStatement = (
  statement: IResolvable | wafv2.CfnWebACL.ByteMatchStatementProperty | undefined,
): wafv2.CfnWebACL.ByteMatchStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF byte-match statement");
  }
  return statement;
};

const requireSizeConstraintStatement = (
  statement: IResolvable | wafv2.CfnWebACL.SizeConstraintStatementProperty | undefined,
): wafv2.CfnWebACL.SizeConstraintStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF size-constraint statement");
  }
  return statement;
};

const requireManagedRuleGroupStatement = (
  statement: IResolvable | wafv2.CfnWebACL.ManagedRuleGroupStatementProperty | undefined,
): wafv2.CfnWebACL.ManagedRuleGroupStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF managed-rule-group statement");
  }
  return statement;
};

const requireLabelMatchStatement = (
  statement: IResolvable | wafv2.CfnWebACL.LabelMatchStatementProperty | undefined,
): wafv2.CfnWebACL.LabelMatchStatementProperty => {
  if (statement === undefined || "resolve" in statement) {
    throw new Error("Expected an inline WAF label-match statement");
  }
  return statement;
};

const assertBoundedGetRoute = (
  statement: wafv2.CfnWebACL.StatementProperty,
  host: string,
  path: string,
  maxBytes: number,
): void => {
  const and = requireAndStatement(statement.andStatement);
  const statements = requireStatements(and.statements);
  assert.deepEqual(
    statements.slice(0, 3).map((part) =>
      requireByteMatchStatement(part.byteMatchStatement).searchString),
    ["GET", host, path],
  );
  const sizeConstraint = requireSizeConstraintStatement(
    statements[3]?.sizeConstraintStatement,
  );
  assert.equal(
    sizeConstraint.comparisonOperator,
    "LE",
  );
  assert.equal(sizeConstraint.size, maxBytes);
  assert.deepEqual(
    sizeConstraint.fieldToMatch,
    { queryString: {} },
  );
};

test("WAF counts the managed query-size rule and re-blocks outside exact bounded auth GETs", (): void => {
  const rules = buildIngressWafRules("app.example.com", "auth.example.com");
  const managedRule = getRule(rules, "AWSManagedCommonRules");
  const managedStatement = requireStatement(managedRule.statement);
  const managedRuleGroup = requireManagedRuleGroupStatement(
    managedStatement.managedRuleGroupStatement,
  );
  const overrides = requireRuleActionOverrides(
    managedRuleGroup.ruleActionOverrides,
  );
  assert.deepEqual(
    overrides.map((override) => override.name),
    [
      "CrossSiteScripting_BODY",
      "SizeRestrictions_BODY",
      "SizeRestrictions_QUERYSTRING",
      "EC2MetaDataSSRF_BODY",
    ],
  );

  const queryRule = getRule(rules, "BlockUnexpectedQuerySizeMatches");
  const queryStatement = requireStatement(queryRule.statement);
  const reblock = requireAndStatement(queryStatement.andStatement);
  const reblockStatements = requireStatements(reblock.statements);
  assert.equal(
    requireLabelMatchStatement(reblockStatements[0]?.labelMatchStatement).key,
    "awswaf:managed:aws:core-rule-set:SizeRestrictions_QueryString",
  );
  const exception = requireNotStatement(reblockStatements[1]?.notStatement);
  const allowed = requireStatement(exception.statement);
  const allowedRouteGroup = requireOrStatement(allowed.orStatement);
  const allowedRoutes = requireStatements(allowedRouteGroup.statements);
  assert.equal(allowedRoutes.length, 2);
  assertBoundedGetRoute(
    allowedRoutes[0] ?? {},
    "auth.example.com",
    "/oauth/authorize",
    MAX_OAUTH_AUTHORIZE_QUERY_BYTES,
  );
  assertBoundedGetRoute(
    allowedRoutes[1] ?? {},
    "auth.example.com",
    "/login",
    MAX_OAUTH_LOGIN_QUERY_BYTES,
  );
});

test("WAF re-blocks managed EC2 metadata SSRF body matches outside exact JSON client registration", (): void => {
  const rules = buildIngressWafRules("app.example.com", "auth.example.com");
  assert.deepEqual(
    rules.map((rule) => [rule.name, rule.priority]),
    [
      ["AWSManagedCommonRules", 0],
      ["BlockUnexpectedXssBodyMatches", 1],
      ["BlockUnexpectedBodySizeMatches", 2],
      ["BlockUnexpectedQuerySizeMatches", 3],
      ["BlockUnexpectedEc2MetadataSsrfBodyMatches", 4],
      ["AWSManagedKnownBadInputs", 5],
      ["RateLimitDynamicClientRegistration", 6],
      ["RateLimitOAuthTokenExchanges", 7],
    ],
  );

  const managedRule = getRule(rules, "AWSManagedCommonRules");
  const managedStatement = requireStatement(managedRule.statement);
  const managedRuleGroup = requireManagedRuleGroupStatement(
    managedStatement.managedRuleGroupStatement,
  );
  const overrides = requireRuleActionOverrides(
    managedRuleGroup.ruleActionOverrides,
  );
  assert.deepEqual(
    overrides.find((override) => override.name === "EC2MetaDataSSRF_BODY"),
    {
      name: "EC2MetaDataSSRF_BODY",
      actionToUse: { count: {} },
    },
  );

  const reblockRule = getRule(rules, "BlockUnexpectedEc2MetadataSsrfBodyMatches");
  assert.equal(reblockRule.priority, 4);
  assert.deepEqual(reblockRule.action, { block: {} });
  assert.deepEqual(reblockRule.visibilityConfig, {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "expense-tracker-ec2-metadata-ssrf-body-reblock",
  });

  const reblockStatement = requireStatement(reblockRule.statement);
  const reblock = requireAndStatement(reblockStatement.andStatement);
  const reblockStatements = requireStatements(reblock.statements);
  assert.equal(
    requireLabelMatchStatement(reblockStatements[0]?.labelMatchStatement).key,
    "awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body",
  );
  const exception = requireNotStatement(reblockStatements[1]?.notStatement);
  const allowedRequest = requireStatement(exception.statement);
  const allowedRequestAnd = requireAndStatement(allowedRequest.andStatement);
  const allowedConditions = requireStatements(allowedRequestAnd.statements);
  assert.deepEqual(
    allowedConditions.map((condition) =>
      requireByteMatchStatement(condition.byteMatchStatement)),
    [
      {
        fieldToMatch: { singleHeader: { Name: "host" } },
        positionalConstraint: "EXACTLY",
        searchString: "auth.example.com",
        textTransformations: [{ priority: 0, type: "LOWERCASE" }],
      },
      {
        fieldToMatch: { method: {} },
        positionalConstraint: "EXACTLY",
        searchString: "POST",
        textTransformations: [{ priority: 0, type: "NONE" }],
      },
      {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: "EXACTLY",
        searchString: "/oauth/register",
        textTransformations: [{ priority: 0, type: "NONE" }],
      },
      {
        fieldToMatch: { singleHeader: { Name: "content-type" } },
        positionalConstraint: "STARTS_WITH",
        searchString: "application/json",
        textTransformations: [{ priority: 0, type: "LOWERCASE" }],
      },
    ],
  );
});

test("WAF rate limits exact dynamic client registration requests by trusted Cloudflare client IP", (): void => {
  const rules = buildIngressWafRules("app.example.com", "auth.example.com");
  const rule = getRule(rules, "RateLimitDynamicClientRegistration");
  assert.equal(rule.priority, 6);
  assert.deepEqual(rule.action, { block: {} });

  const statement = requireStatement(rule.statement);
  const rateBasedStatement = requireRateBasedStatement(statement.rateBasedStatement);
  assert.equal(rateBasedStatement.aggregateKeyType, "FORWARDED_IP");
  assert.equal(rateBasedStatement.evaluationWindowSec, 60);
  assert.equal(rateBasedStatement.limit, 10);
  assert.deepEqual(rateBasedStatement.forwardedIpConfig, {
    headerName: "CF-Connecting-IP",
    fallbackBehavior: "MATCH",
  });

  const scopeDownStatement = requireStatement(rateBasedStatement.scopeDownStatement);
  const scopeDown = requireAndStatement(scopeDownStatement.andStatement);
  const conditions = requireStatements(scopeDown.statements);
  assert.deepEqual(
    conditions.map((condition) =>
      requireByteMatchStatement(condition.byteMatchStatement).searchString),
    ["auth.example.com", "POST", "/oauth/register"],
  );
  assert.deepEqual(
    conditions.map((condition) =>
      requireByteMatchStatement(condition.byteMatchStatement).fieldToMatch),
    [
      { singleHeader: { Name: "host" } },
      { method: {} },
      { uriPath: {} },
    ],
  );
  assert.deepEqual(rule.visibilityConfig, {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "expense-tracker-dcr-rate-limit",
  });
});

test("WAF separately rate limits exact OAuth token exchanges by trusted Cloudflare client IP", (): void => {
  const rules = buildIngressWafRules("app.example.com", "auth.example.com");
  const rule = getRule(rules, "RateLimitOAuthTokenExchanges");
  assert.equal(rule.priority, 7);
  assert.deepEqual(rule.action, { block: {} });

  const statement = requireStatement(rule.statement);
  const rateBasedStatement = requireRateBasedStatement(statement.rateBasedStatement);
  assert.equal(rateBasedStatement.aggregateKeyType, "FORWARDED_IP");
  assert.equal(rateBasedStatement.evaluationWindowSec, 60);
  assert.equal(rateBasedStatement.limit, 60);
  assert.deepEqual(rateBasedStatement.forwardedIpConfig, {
    headerName: "CF-Connecting-IP",
    fallbackBehavior: "MATCH",
  });

  const scopeDownStatement = requireStatement(rateBasedStatement.scopeDownStatement);
  const scopeDown = requireAndStatement(scopeDownStatement.andStatement);
  const conditions = requireStatements(scopeDown.statements);
  assert.deepEqual(
    conditions.map((condition) =>
      requireByteMatchStatement(condition.byteMatchStatement).searchString),
    ["auth.example.com", "POST", "/oauth/token"],
  );
  assert.deepEqual(
    conditions.map((condition) =>
      requireByteMatchStatement(condition.byteMatchStatement).fieldToMatch),
    [
      { singleHeader: { Name: "host" } },
      { method: {} },
      { uriPath: {} },
    ],
  );
  assert.deepEqual(
    conditions.map((condition) =>
      requireByteMatchStatement(condition.byteMatchStatement).positionalConstraint),
    ["EXACTLY", "EXACTLY", "EXACTLY"],
  );
  assert.deepEqual(rule.visibilityConfig, {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "expense-tracker-oauth-token-rate-limit",
  });
});
