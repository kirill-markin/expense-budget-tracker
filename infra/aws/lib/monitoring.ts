import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { CHAT_SANDBOX_RESERVED_CONCURRENCY } from "./chat-sandbox";

export interface MonitoringProps {
  alertEmail: string;
  alb: elbv2.ApplicationLoadBalancer;
  webTargetGroup: elbv2.ApplicationTargetGroup;
  webLogGroup: logs.LogGroup;
  authLogGroup: logs.LogGroup;
  webAclName: string;
  webService: ecs.FargateService;
  cluster: ecs.Cluster;
  db: rds.DatabaseInstance;
  fxFetcher: lambda.Function;
  restApi: apigw.RestApi;
  authorizerFn: lambda.Function;
  sqlApiFn: lambda.Function;
  mcpHttpApi: apigwv2.HttpApi;
  mcpFn: lambda.Function;
  chatSandboxFn: lambda.Function;
  customEmailSenderFn: lambda.IFunction;
}

export interface MonitoringResult {
  alertTopic: sns.Topic;
}

export function monitoring(scope: Construct, props: MonitoringProps): MonitoringResult {
  // --- SNS Topic for alerts ---
  const alertTopic = new sns.Topic(scope, "AlertTopic", {
    topicName: "expense-tracker-alerts",
  });
  new sns.Subscription(scope, "AlertEmailSubscriptionV2", {
    topic: alertTopic,
    protocol: sns.SubscriptionProtocol.EMAIL,
    endpoint: props.alertEmail,
  });

  // Availability-critical alarms also report recovery, so an incident is never left looking unresolved
  const notifyOnAlarmAndRecovery = (alarm: cloudwatch.Alarm): void => {
    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
    alarm.addOkAction(new cloudwatch_actions.SnsAction(alertTopic));
  };

  // --- CloudWatch Alarms ---
  // ALB 5xx errors
  notifyOnAlarmAndRecovery(
    new cloudwatch.Alarm(scope, "Alb5xxAlarm", {
      metric: props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: "ALB returned 5+ server errors in 5 minutes",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
  );

  // Web target 5xx errors
  notifyOnAlarmAndRecovery(
    new cloudwatch.Alarm(scope, "WebTarget5xxAlarm", {
      metric: props.webTargetGroup.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        {
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        },
      ),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: "Web target returned server errors",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
  );

  // Web target health
  notifyOnAlarmAndRecovery(
    new cloudwatch.Alarm(scope, "WebTargetHealthAlarm", {
      metric: props.webTargetGroup.metrics.healthyHostCount({
        period: cdk.Duration.minutes(1),
        statistic: "Minimum",
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      alarmDescription: "Web target group had no healthy hosts for 2 minutes",
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }),
  );

  // WAF blocks by the request body size re-block rule
  new cloudwatch.Alarm(scope, "WafSizeBodyBlockedAlarm", {
    metric: new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        WebACL: props.webAclName,
        Region: cdk.Aws.REGION,
        Rule: "expense-tracker-size-body-reblock",
      },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "WAF blocked a request because of an unexpected large body",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  new cloudwatch.Alarm(scope, "WafSizeQueryBlockedAlarm", {
    metric: new cloudwatch.Metric({
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      dimensionsMap: {
        WebACL: props.webAclName,
        Region: cdk.Aws.REGION,
        Rule: "expense-tracker-size-query-reblock",
      },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "WAF blocked a request because of an unexpected large query string",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // WAF blocks by the Cloudflare origin-secret rule.
  // The rule is absent until originSharedSecret is configured, so the metric simply
  // never reports while the feature is inert. Once it is on, a secret that diverges
  // from the Cloudflare Transform Rule blocks all public traffic while ALB target
  // health checks keep passing, because they never traverse the web ACL, so this
  // alarm is the only signal of a total outage and must fire even on a quiet night.
  // The ALB accepts Cloudflare ranges only, so nothing else reaches the web ACL and
  // background noise on this rule is near zero: a low per-minute threshold is safe,
  // and short bursts are absorbed by requiring 3 breaching minutes out of 5 instead.
  notifyOnAlarmAndRecovery(
    new cloudwatch.Alarm(scope, "WafOriginSecretBlockedAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "AWS/WAFV2",
        metricName: "BlockedRequests",
        dimensionsMap: {
          WebACL: props.webAclName,
          Region: cdk.Aws.REGION,
          Rule: "expense-tracker-origin-secret-block",
        },
        period: cdk.Duration.minutes(1),
        statistic: "Sum",
      }),
      threshold: 3,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      alarmDescription:
        "WAF blocked requests missing the Cloudflare origin shared secret in 3 of the last 5 minutes — the deployed secret may not match the Cloudflare Transform Rule",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
  );

  const webErrorMetricFilter = new logs.MetricFilter(scope, "WebErrorMetricFilter", {
    logGroup: props.webLogGroup,
    filterPattern: logs.FilterPattern.any(
      logs.FilterPattern.stringValue("$.action", "=", "error"),
      logs.FilterPattern.stringValue("$.action", "=", "transcription_failed"),
      logs.FilterPattern.stringValue("$.action", "=", "task_protection_enable_failed"),
      logs.FilterPattern.stringValue("$.action", "=", "task_protection_disable_failed"),
    ),
    metricNamespace: "ExpenseBudgetTracker/Web",
    metricName: "ErrorEvents",
    metricValue: "1",
  });

  new cloudwatch.Alarm(scope, "WebErrorEventsAlarm", {
    metric: webErrorMetricFilter.metric({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "Web application logged an error event",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // --- Postgres pool errors ---
  // Every pool logs an error instead of crashing when the server closes a pooled
  // connection, so these log lines are the only signal that a pool is failing.
  // All surfaces feed one metric: the pools all talk to the same database.
  const dbPoolErrorNamespace = "ExpenseBudgetTracker/Db";
  const dbPoolErrorMetricName = "PoolErrors";

  const countDbPoolErrors = (
    id: string,
    logGroup: logs.ILogGroup,
    filterPattern: logs.IFilterPattern,
  ): void => {
    new logs.MetricFilter(scope, id, {
      logGroup,
      filterPattern,
      metricNamespace: dbPoolErrorNamespace,
      metricName: dbPoolErrorMetricName,
      metricValue: "1",
      // Publish an explicit 0 for periods with no match, so "errors in every one of the last
      // N periods" is decided by real datapoints instead of by missing-data padding.
      defaultValue: 0,
    });
  };

  // ECS ships each structured log line to CloudWatch verbatim, so it matches as JSON.
  countDbPoolErrors(
    "WebDbPoolErrorMetricFilter",
    props.webLogGroup,
    logs.FilterPattern.all(
      logs.FilterPattern.stringValue("$.domain", "=", "db"),
      logs.FilterPattern.stringValue("$.action", "=", "pool_error"),
    ),
  );
  countDbPoolErrors(
    "AuthDbPoolErrorMetricFilter",
    props.authLogGroup,
    logs.FilterPattern.all(
      logs.FilterPattern.stringValue("$.domain", "=", "auth"),
      logs.FilterPattern.stringValue("$.action", "=", "db_pool_error"),
    ),
  );

  // Lambda prefixes every stdout line with a timestamp and request id, but a JSON filter
  // still matches the object that follows that prefix, so the three Lambda surfaces are
  // matched on their structured fields like the ECS ones. A bare term would also count any
  // line that merely quotes the action name, and the machine-API and MCP groups carry
  // client-derived text such as the identifier echoed back in a `sql_policy_rejected`
  // message. All three bundle `apps/sql-api`, so they share one pool logger and one
  // pattern: that same pattern covers the authorizer group, which emits no client-derived
  // text of its own. Reading `fn.logGroup` also materializes the function log group the
  // filter needs to attach to.
  // A frozen execution environment cannot process I/O, so a pooled connection dropped while
  // it sleeps only surfaces when that environment is next thawed.
  const sqlApiDbPoolErrorPattern = logs.FilterPattern.all(
    logs.FilterPattern.stringValue("$.domain", "=", "sql_api"),
    logs.FilterPattern.stringValue("$.action", "=", "database_pool_error"),
  );
  countDbPoolErrors(
    "AuthorizerDbPoolErrorMetricFilter",
    props.authorizerFn.logGroup,
    sqlApiDbPoolErrorPattern,
  );
  countDbPoolErrors(
    "SqlApiDbPoolErrorMetricFilter",
    props.sqlApiFn.logGroup,
    sqlApiDbPoolErrorPattern,
  );
  countDbPoolErrors("McpDbPoolErrorMetricFilter", props.mcpFn.logGroup, sqlApiDbPoolErrorPattern);
  // The FX fetcher has no structured logger and logs the error as plain text. Its pool is
  // opened and ended inside a single scheduled invocation, so only a connection dropped
  // during that run reaches this filter.
  countDbPoolErrors(
    "FxDbPoolErrorMetricFilter",
    props.fxFetcher.logGroup,
    logs.FilterPattern.allTerms("Postgres pool error"),
  );

  new cloudwatch.Alarm(scope, "DbPoolErrorsAlarm", {
    metric: new cloudwatch.Metric({
      namespace: dbPoolErrorNamespace,
      metricName: dbPoolErrorMetricName,
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    // Every one of the six periods has to contain a matching line. A one-off drop is
    // self-limiting — each pool logs it once and reconnects, and each stale Lambda
    // environment logs it once when it is next thawed — so it is very unlikely to fill
    // all six.
    evaluationPeriods: 6,
    datapointsToAlarm: 6,
    alarmDescription:
      "Postgres pool errors in every one of the last 6 five-minute periods — a single connection loss (routine RDS maintenance, restart, failover) is logged once per pool and rarely fills every period, so this means connections keep being dropped",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // ECS CPU > 80% for 15 minutes
  notifyOnAlarmAndRecovery(
    new cloudwatch.Alarm(scope, "EcsCpuAlarm", {
      metric: props.webService.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: "ECS CPU above 80% for 15 minutes",
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }),
  );

  // ECS CPU spike: catches a multi-minute saturation that the 15-minute average alarm misses.
  // Missing data is NOT_BREACHING here because a 1-minute window sees ordinary metric gaps.
  notifyOnAlarmAndRecovery(
    new cloudwatch.Alarm(scope, "EcsCpuSpikeAlarm", {
      metric: props.webService.metricCpuUtilization({
        period: cdk.Duration.minutes(1),
        statistic: "Maximum",
      }),
      threshold: 90,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      alarmDescription: "ECS CPU spike: above 90% for 2 of the last 3 minutes (short window)",
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }),
  );

  // ECS Memory > 80% for 15 minutes
  new cloudwatch.Alarm(scope, "EcsMemoryAlarm", {
    metric: props.webService.metricMemoryUtilization({
      period: cdk.Duration.minutes(5),
      statistic: "Average",
    }),
    threshold: 80,
    evaluationPeriods: 3,
    alarmDescription: "ECS memory above 80% for 15 minutes",
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // ECS scale-out alert: fires when running more than 1 task (auto-scaling kicked in)
  new cloudwatch.Alarm(scope, "EcsScaleOutAlarm", {
    metric: new cloudwatch.Metric({
      namespace: "AWS/ECS",
      metricName: "RunningTaskCount",
      dimensionsMap: {
        ClusterName: props.cluster.clusterName,
        ServiceName: props.webService.serviceName,
      },
      period: cdk.Duration.minutes(1),
      statistic: "Maximum",
    }),
    threshold: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    evaluationPeriods: 1,
    alarmDescription: "ECS auto-scaled beyond 1 task — check traffic and cost",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // RDS DB connections > 80% of max (t4g.micro max ~85 connections)
  new cloudwatch.Alarm(scope, "DbConnectionsAlarm", {
    metric: props.db.metricDatabaseConnections({
      period: cdk.Duration.minutes(5),
      statistic: "Average",
    }),
    threshold: 68,
    evaluationPeriods: 2,
    alarmDescription: "RDS connections above 80% capacity (68/85)",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // RDS free storage < 2 GB
  new cloudwatch.Alarm(scope, "DbStorageAlarm", {
    metric: props.db.metricFreeStorageSpace({
      period: cdk.Duration.minutes(15),
      statistic: "Average",
    }),
    threshold: 2 * 1024 * 1024 * 1024,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    evaluationPeriods: 1,
    alarmDescription: "RDS free storage below 2 GB",
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // Lambda FX fetcher errors
  new cloudwatch.Alarm(scope, "FxLambdaErrorAlarm", {
    metric: props.fxFetcher.metricErrors({
      period: cdk.Duration.hours(1),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "FX fetcher Lambda had errors",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // A normal FX fetch runs in seconds now that ECB is fetched incrementally and the daily
  // rates table is rebuilt incrementally, so 1 minute flags a regression long before the
  // unchanged 5-minute Lambda timeout.
  new cloudwatch.Alarm(scope, "FxLambdaDurationAlarm", {
    metric: props.fxFetcher.metricDuration({
      period: cdk.Duration.hours(1),
      statistic: "Maximum",
    }),
    threshold: 60_000,
    evaluationPeriods: 1,
    alarmDescription: "FX fetcher Lambda duration exceeded 1 minute (timeout is 5 minutes)",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // API Gateway 5xx errors
  new cloudwatch.Alarm(scope, "ApiGateway5xxAlarm", {
    metric: new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName: "5XXError",
      dimensionsMap: { ApiName: props.restApi.restApiName },
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 5,
    evaluationPeriods: 1,
    alarmDescription: "API Gateway returned 5+ server errors in 5 minutes",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // SQL API Authorizer Lambda errors
  new cloudwatch.Alarm(scope, "AuthorizerLambdaErrorAlarm", {
    metric: props.authorizerFn.metricErrors({
      period: cdk.Duration.hours(1),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "SQL API authorizer Lambda had errors",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // SQL API executor Lambda errors
  new cloudwatch.Alarm(scope, "SqlApiLambdaErrorAlarm", {
    metric: props.sqlApiFn.metricErrors({
      period: cdk.Duration.hours(1),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "SQL API executor Lambda had errors",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  new cloudwatch.Alarm(scope, "McpApiGateway5xxAlarm", {
    metric: props.mcpHttpApi.metricServerError({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 5,
    evaluationPeriods: 1,
    alarmDescription: "MCP HTTP API returned 5+ server errors in 5 minutes",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  new cloudwatch.Alarm(scope, "McpLambdaErrorAlarm", {
    metric: props.mcpFn.metricErrors({
      period: cdk.Duration.minutes(15),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "MCP Lambda had errors",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  new cloudwatch.Alarm(scope, "McpLambdaThrottleAlarm", {
    metric: props.mcpFn.metricThrottles({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "MCP Lambda invocation was throttled; reserved concurrency limit is 20",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // Chat sandbox Lambda errors. It opens no database connection, so it has no
  // pool-error filter above.
  //
  // An error here is a fault an operator has to fix, and that is what the
  // threshold of one is for. Nothing a payload can ask for is meant to reach
  // it: a command that fails, overruns its budget or kills its own process
  // comes back as tool output with a non-zero exit code, a document that cannot
  // be converted comes back as `status: "failed"` - including one whose text
  // will not fit in a JavaScript string and one whose conversion child crossed
  // its memory ceiling - and object storage refusing or not answering, or the
  // kernel picking that child for another process's memory, comes back as
  // `status: "unavailable"` for the caller to retry.
  //
  // What is left is every raise path that reaches the handler. The list is kept
  // complete, and kept here, because the threshold of one is only defensible
  // while every entry on it is a defect - a representative list cannot carry
  // that argument. Grouped by what is broken:
  //
  // Deployment wiring, read once from the environment: CHAT_SANDBOX_OBJECT_HOSTS
  // unset, or carrying an entry that is not a bare `host` or `host:port`. A
  // typo there raises on the deployment's first request and is plausibly the
  // likeliest entry here to ever fire.
  //
  // A caller not holding to this sandbox's contract: a payload that does not
  // match its schema; a payload naming an `operation` this sandbox does not
  // serve; a pre-signed URL whose host is not one of the deployment's; a
  // prepare request carrying fewer write slots than a source has parts; and a
  // caller invoking one runner concurrently.
  //
  // The build: a bundle that cannot load one of the document parsers; and a
  // TypeError, ReferenceError or RangeError of the sandbox's own, every one of
  // them but the `Invalid string length` the answer above covers - so a parser
  // overrunning its own recursion on a deeply nested document pages here,
  // carrying V8's text, rather than being written down as that document being
  // broken.
  //
  // The child protocol, on the bash path and the conversion path alike: a child
  // that could not be forked, never completed its ready handshake, or reported
  // ready without a pid; a command or a conversion that could not be sent to a
  // child which had just reported ready; an IPC or serialization `error` event
  // on a channel a command had already been written to; and an exit reporting a
  // signal `os.constants.signals` does not number, or reporting neither a code
  // nor a signal.
  //
  // The runtime: a /proc/<pid>/status publishing a memory block with no `VmRSS`
  // line, which leaves a conversion child's resident memory unbounded.
  //
  // Each is a wiring, contract, build or runtime defect that no retry fixes and
  // that nothing else reports. What is deliberately not on the list is
  // presignedFs.ts's refusals: they are raised into just-bash and consumed by
  // it as a failing command, and never reach the handler.
  //
  // The runtime entry is also the one exception to how they arrive: it is read
  // from a poll timer rather than from the request, so it lands as an
  // uncaughtException with no response written, where every other entry is a
  // rejected handler promise.
  new cloudwatch.Alarm(scope, "ChatSandboxLambdaErrorAlarm", {
    metric: props.chatSandboxFn.metricErrors({
      period: cdk.Duration.minutes(15),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "Chat sandbox Lambda had errors",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  new cloudwatch.Alarm(scope, "ChatSandboxLambdaThrottleAlarm", {
    metric: props.chatSandboxFn.metricThrottles({
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: `Chat sandbox Lambda invocation was throttled; reserved concurrency limit is ${String(CHAT_SANDBOX_RESERVED_CONCURRENCY)}`,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // Cognito custom email sender Lambda errors
  new cloudwatch.Alarm(scope, "CustomEmailSenderLambdaErrorAlarm", {
    metric: props.customEmailSenderFn.metricErrors({
      period: cdk.Duration.minutes(15),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "Custom email sender Lambda had errors",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // Cognito custom email sender Lambda throttles
  new cloudwatch.Alarm(scope, "CustomEmailSenderLambdaThrottleAlarm", {
    metric: props.customEmailSenderFn.metricThrottles({
      period: cdk.Duration.minutes(15),
      statistic: "Sum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "Custom email sender Lambda was throttled",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  return { alertTopic };
}
