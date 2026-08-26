import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import { Template } from "aws-cdk-lib/assertions";
import { monitoring } from "./monitoring";

// Pinned so the synthesized template never depends on the environment running the tests.
const TEST_ENV: cdk.Environment = { account: "123456789012", region: "eu-central-1" };

const POOL_ERROR_NAMESPACE = "ExpenseBudgetTracker/Db";
const POOL_ERROR_METRIC_NAME = "PoolErrors";

// Rendered CloudWatch filter patterns, written out literally so they can be compared with a
// real log line: the ECS surfaces log one JSON object per line, while Lambda prefixes every
// line with a timestamp and request id and can only be matched as text.
const WEB_POOL_ERROR_PATTERN = '{ ($.domain = "db") && ($.action = "pool_error") }';
const AUTH_POOL_ERROR_PATTERN = '{ ($.domain = "auth") && ($.action = "db_pool_error") }';
const SQL_API_POOL_ERROR_PATTERN = '"database_pool_error"';
const FX_POOL_ERROR_PATTERN = '"Postgres pool error"';

type MetricFilterShape = Readonly<{
  logGroup: string;
  pattern: string;
  defaultValue: unknown;
}>;

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a template object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a literal string, got ${JSON.stringify(value)}`);
  }
  return value;
};

const stubFunction = (stack: cdk.Stack, id: string): lambda.Function =>
  new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({});"),
  });

const stubWebService = (stack: cdk.Stack, cluster: ecs.Cluster): ecs.FargateService => {
  const taskDefinition = new ecs.FargateTaskDefinition(stack, "WebTaskDef", {
    cpu: 256,
    memoryLimitMiB: 512,
  });
  taskDefinition.addContainer("web", {
    image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/nginx:stable"),
    portMappings: [{ containerPort: 8080 }],
  });
  return new ecs.FargateService(stack, "WebService", { cluster, taskDefinition });
};

// monitoring() is the real production function; everything it observes is stubbed with the
// same construct types the stack passes in, so a pool that loses its metric filter here
// loses its alarm in production too.
const synthesizeMonitoringTemplate = (): Template => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "MonitoringTestStack", { env: TEST_ENV });
  const vpc = new ec2.Vpc(stack, "Vpc");
  const cluster = new ecs.Cluster(stack, "Cluster", { vpc });
  const restApi = new apigw.RestApi(stack, "RestApi");
  restApi.root.addMethod("GET");
  const alb = new elbv2.ApplicationLoadBalancer(stack, "Alb", { vpc });
  const webTargetGroup = new elbv2.ApplicationTargetGroup(stack, "WebTargetGroup", {
    vpc,
    port: 8080,
    targetType: elbv2.TargetType.IP,
  });
  // monitoring() reads webTargetGroup.metrics, which resolves the load balancer name from
  // the first listener and throws while the target group is attached to none. ingress()
  // always forwards to it from a listener, so the stub has to as well. `open: false`
  // matches ingress() and keeps the synthesized security group closed.
  alb.addListener("AlbTestListener", {
    port: 80,
    open: false,
    defaultTargetGroups: [webTargetGroup],
  });
  monitoring(stack, {
    alertEmail: "alerts@example.com",
    alb,
    webTargetGroup,
    webLogGroup: new logs.LogGroup(stack, "WebLogGroup"),
    authLogGroup: new logs.LogGroup(stack, "AuthLogGroup"),
    webAclName: "expense-tracker-web-acl",
    webService: stubWebService(stack, cluster),
    cluster,
    db: new rds.DatabaseInstance(stack, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of("18.6", "18"),
      }),
      vpc,
    }),
    fxFetcher: stubFunction(stack, "FxFetcher"),
    restApi,
    authorizerFn: stubFunction(stack, "AuthorizerFn"),
    sqlApiFn: stubFunction(stack, "SqlApiFn"),
    mcpHttpApi: new apigwv2.HttpApi(stack, "McpHttpApi"),
    mcpFn: stubFunction(stack, "McpFn"),
    customEmailSenderFn: stubFunction(stack, "CustomEmailSenderFn"),
  });
  return Template.fromStack(stack);
};

const singleTransformation = (properties: Record<string, unknown>): Record<string, unknown> => {
  const transformations = properties.MetricTransformations;
  if (!Array.isArray(transformations) || transformations.length !== 1) {
    throw new Error(`Expected one metric transformation, got ${JSON.stringify(transformations)}`);
  }
  return asRecord(transformations[0]);
};

const poolErrorMetricFilters = (template: Template): ReadonlyArray<MetricFilterShape> =>
  Object.values(template.findResources("AWS::Logs::MetricFilter"))
    .map((resource) => asRecord(asRecord(resource).Properties))
    .map((properties) => ({ properties, transformation: singleTransformation(properties) }))
    .filter(
      ({ transformation }) =>
        transformation.MetricNamespace === POOL_ERROR_NAMESPACE
        && transformation.MetricName === POOL_ERROR_METRIC_NAME,
    )
    .map(({ properties, transformation }) => ({
      logGroup: JSON.stringify(properties.LogGroupName),
      pattern: requireString(properties.FilterPattern, "FilterPattern"),
      defaultValue: transformation.DefaultValue,
    }));

// The ECS log groups are declared by the stack, so their metric filters reference them by
// logical id and the pairing of pattern to log group can be pinned.
const logGroupRef = (template: Template, constructId: string): string => {
  const matches = Object.keys(template.findResources("AWS::Logs::LogGroup")).filter((logicalId) =>
    logicalId.startsWith(constructId),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${constructId} log group, found ${matches.length}`);
  }
  return JSON.stringify({ Ref: matches[0] });
};

const patternsWatching = (
  filters: ReadonlyArray<MetricFilterShape>,
  logGroup: string,
): ReadonlyArray<string> =>
  filters.filter((filter) => filter.logGroup === logGroup).map((filter) => filter.pattern);

const alertTopicLogicalId = (template: Template): string => {
  const topics = Object.entries(template.findResources("AWS::SNS::Topic"));
  if (topics.length !== 1) {
    throw new Error(`Expected exactly one alert topic, found ${topics.length}`);
  }
  return topics[0][0];
};

test("every Postgres pool reports its errors into one shared metric", (): void => {
  const template = synthesizeMonitoringTemplate();
  const filters = poolErrorMetricFilters(template);

  assert.deepEqual(
    filters.map((filter) => filter.pattern).sort(),
    [
      AUTH_POOL_ERROR_PATTERN,
      FX_POOL_ERROR_PATTERN,
      SQL_API_POOL_ERROR_PATTERN,
      SQL_API_POOL_ERROR_PATTERN,
      SQL_API_POOL_ERROR_PATTERN,
      WEB_POOL_ERROR_PATTERN,
    ].sort(),
  );
  assert.equal(
    new Set(filters.map((filter) => filter.logGroup)).size,
    filters.length,
    "Expected each pool-error metric filter to watch a different log group",
  );
  // The two ECS patterns are near-identical, so a swap between them would keep the checks
  // above green while blinding both services. The three Lambda surfaces share one pattern.
  assert.deepEqual(patternsWatching(filters, logGroupRef(template, "WebLogGroup")), [
    WEB_POOL_ERROR_PATTERN,
  ]);
  assert.deepEqual(patternsWatching(filters, logGroupRef(template, "AuthLogGroup")), [
    AUTH_POOL_ERROR_PATTERN,
  ]);
  // A period with no matching line must publish a real 0, so the alarm below decides on
  // datapoints instead of on how CloudWatch pads a sparse metric.
  assert.deepEqual(
    filters.map((filter) => filter.defaultValue),
    filters.map(() => 0),
  );
});

test("the pool error alarm needs errors in 6 consecutive periods, not one burst", (): void => {
  const template = synthesizeMonitoringTemplate();
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"))
    .map((resource) => asRecord(asRecord(resource).Properties))
    .filter((properties) => properties.MetricName === POOL_ERROR_METRIC_NAME);

  assert.equal(alarms.length, 1);
  const alarm = alarms[0];
  assert.equal(alarm.Namespace, POOL_ERROR_NAMESPACE);
  assert.equal(alarm.Statistic, "Sum");
  // Six 5-minute periods, every one of which has to contain a matching line: a one-off
  // connection loss is self-limiting — each pool logs it once and reconnects, and a stale
  // Lambda environment logs it once when it is next thawed — so it is very unlikely to
  // fill all six.
  assert.equal(alarm.Period, 300);
  assert.equal(alarm.EvaluationPeriods, 6);
  assert.equal(alarm.DatapointsToAlarm, 6);
  assert.equal(alarm.Threshold, 1);
  assert.equal(alarm.ComparisonOperator, "GreaterThanOrEqualToThreshold");
  assert.equal(alarm.TreatMissingData, "notBreaching");
  assert.deepEqual(alarm.AlarmActions, [{ Ref: alertTopicLogicalId(template) }]);
});
