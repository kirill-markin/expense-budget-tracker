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

const assertBoundedGetRoute = (
  statement: wafv2.CfnWebACL.StatementProperty,
  host: string,
  path: string,
  maxBytes: number,
): void => {
  const statements = requireStatements(statement.andStatement?.statements);
  assert.deepEqual(
    statements.slice(0, 3).map((part) => part.byteMatchStatement?.searchString),
    ["GET", host, path],
  );
  assert.equal(
    statements[3]?.sizeConstraintStatement?.comparisonOperator,
    "LE",
  );
  assert.equal(statements[3]?.sizeConstraintStatement?.size, maxBytes);
  assert.deepEqual(
    statements[3]?.sizeConstraintStatement?.fieldToMatch,
    { queryString: {} },
  );
};

test("WAF counts the managed query-size rule and re-blocks outside exact bounded auth GETs", (): void => {
  const rules = buildIngressWafRules("app.example.com", "auth.example.com");
  const managedRule = getRule(rules, "AWSManagedCommonRules");
  const managedStatement = requireStatement(managedRule.statement);
  const overrides = requireRuleActionOverrides(
    managedStatement.managedRuleGroupStatement?.ruleActionOverrides,
  );
  assert.deepEqual(
    overrides.map((override) => override.name),
    ["CrossSiteScripting_BODY", "SizeRestrictions_BODY", "SizeRestrictions_QUERYSTRING"],
  );

  const queryRule = getRule(rules, "BlockUnexpectedQuerySizeMatches");
  const queryStatement = requireStatement(queryRule.statement);
  const reblockStatements = requireStatements(queryStatement.andStatement?.statements);
  assert.equal(
    reblockStatements[0]?.labelMatchStatement?.key,
    "awswaf:managed:aws:core-rule-set:SizeRestrictions_QueryString",
  );
  const exception = requireStatement(reblockStatements[1]?.notStatement?.statement);
  const allowedRoutes = requireStatements(exception.orStatement?.statements);
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
