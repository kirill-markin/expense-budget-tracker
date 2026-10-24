import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import * as path from "path";

export interface FxFetcherProps {
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  db: rds.DatabaseInstance;
  workerDbSecret: cdk.aws_secretsmanager.Secret;
  activeFxFetcher: lambda.Function;
}

export interface FxFetcherResult {
  fxFetcher: lambda.Function;
}

export function fxFetcher(scope: Construct, props: FxFetcherProps): FxFetcherResult {
  const fn = new lambda_nodejs.NodejsFunction(scope, "FxFetcher", {
    entry: path.join(__dirname, "../../../apps/worker/src/lambda.ts"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.minutes(5),
    memorySize: 256,
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.lambdaSg],
    environment: {
      NODE_EXTRA_CA_CERTS: "/var/task/rds-global-bundle.pem",
    },
    bundling: {
      minify: true,
      sourceMap: true,
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (_inputDir: string, outputDir: string) => [
          `curl -sfo ${outputDir}/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`,
        ],
      },
    },
  });

  props.workerDbSecret.grantRead(fn);
  fn.addEnvironment("DB_SECRET_ARN", props.workerDbSecret.secretArn);
  fn.addEnvironment("DB_HOST", props.db.dbInstanceEndpointAddress);
  fn.addEnvironment("DB_NAME", "tracker");
  // Retain the legacy log-retention resource after monitoring switches to the image.
  void fn.logGroup;

  const schedule = new events.Rule(scope, "FxSchedule", {
    schedule: events.Schedule.cron({ hour: "8", minute: "0" }),
  });
  // Binding without adding a target preserves the legacy function's exact-rule grant.
  new events_targets.LambdaFunction(fn).bind(schedule, "Legacy");
  schedule.addTarget(new events_targets.LambdaFunction(props.activeFxFetcher));

  return { fxFetcher: props.activeFxFetcher };
}
