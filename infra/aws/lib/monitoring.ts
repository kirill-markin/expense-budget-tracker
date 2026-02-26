import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

export interface MonitoringProps {
  alertEmail: string;
  alb: elbv2.ApplicationLoadBalancer;
  nlb: elbv2.NetworkLoadBalancer;
  webService: ecs.FargateService;
  cluster: ecs.Cluster;
  db: rds.DatabaseInstance;
  fxFetcher: lambda.IFunction;
}

export interface MonitoringResult {
  alertTopic: sns.Topic;
}

export function monitoring(scope: Construct, props: MonitoringProps): MonitoringResult {
  // --- SNS Topic for alerts ---
  const alertTopic = new sns.Topic(scope, "AlertTopic", {
    topicName: "expense-tracker-alerts",
  });
  alertTopic.addSubscription(
    new sns_subscriptions.EmailSubscription(props.alertEmail),
  );

  // --- CloudWatch Alarms ---
  // ALB 5xx errors
  new cloudwatch.Alarm(scope, "Alb5xxAlarm", {
    metric: props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
      period: cdk.Duration.minutes(5),
      statistic: "Sum",
    }),
    threshold: 5,
    evaluationPeriods: 1,
    alarmDescription: "ALB returned 5+ server errors in 5 minutes",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // ECS CPU > 80% for 15 minutes
  new cloudwatch.Alarm(scope, "EcsCpuAlarm", {
    metric: props.webService.metricCpuUtilization({
      period: cdk.Duration.minutes(5),
      statistic: "Average",
    }),
    threshold: 80,
    evaluationPeriods: 3,
    alarmDescription: "ECS CPU above 80% for 15 minutes",
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

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

  // NLB unhealthy targets (direct DB access is down)
  const nlbFullName = props.nlb.loadBalancerFullName;
  new cloudwatch.Alarm(scope, "NlbUnhealthyAlarm", {
    metric: new cloudwatch.Metric({
      namespace: "AWS/NetworkELB",
      metricName: "UnHealthyHostCount",
      dimensionsMap: {
        TargetGroup: "targetgroup/db-nlb-tg",
        LoadBalancer: nlbFullName,
      },
      period: cdk.Duration.minutes(1),
      statistic: "Maximum",
    }),
    threshold: 1,
    evaluationPeriods: 1,
    alarmDescription: "NLB target (RDS) is unhealthy — direct DB access is down",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  // NLB active flow count > 20 for 10 min (connection flood detection)
  new cloudwatch.Alarm(scope, "NlbActiveFlowAlarm", {
    metric: new cloudwatch.Metric({
      namespace: "AWS/NetworkELB",
      metricName: "ActiveFlowCount",
      dimensionsMap: {
        LoadBalancer: nlbFullName,
      },
      period: cdk.Duration.minutes(5),
      statistic: "Average",
    }),
    threshold: 20,
    evaluationPeriods: 2,
    alarmDescription: "NLB active connections above 20 for 10 min — possible connection flood",
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  }).addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

  return { alertTopic };
}
