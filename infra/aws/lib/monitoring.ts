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

export interface MonitoringProps {
  alertEmail: string;
  alb: elbv2.ApplicationLoadBalancer;
  webTargetGroup: elbv2.ApplicationTargetGroup;
  webLogGroup: logs.LogGroup;
  webAclName: string;
  webService: ecs.FargateService;
  cluster: ecs.Cluster;
  db: rds.DatabaseInstance;
  fxFetcher: lambda.IFunction;
  restApi: apigw.RestApi;
  authorizerFn: lambda.IFunction;
  sqlApiFn: lambda.IFunction;
  mcpHttpApi: apigwv2.HttpApi;
  mcpFn: lambda.IFunction;
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

  // Lambda FX fetcher approaching timeout (5 min = 300s, alarm at 4 min = 240s)
  new cloudwatch.Alarm(scope, "FxLambdaDurationAlarm", {
    metric: props.fxFetcher.metricDuration({
      period: cdk.Duration.hours(1),
      statistic: "Maximum",
    }),
    threshold: 240_000,
    evaluationPeriods: 1,
    alarmDescription: "FX fetcher Lambda duration exceeded 4 minutes (timeout is 5)",
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
    alarmDescription: "MCP Lambda throttled despite the five-execution HTTP API capacity envelope",
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
