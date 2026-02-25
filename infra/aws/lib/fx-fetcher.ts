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
  appDbSecret: cdk.aws_secretsmanager.Secret;
}

export interface FxFetcherResult {
  fxFetcher: lambda_nodejs.NodejsFunction;
}

export function fxFetcher(scope: Construct, props: FxFetcherProps): FxFetcherResult {
  // --- Lambda (FX fetchers) ---
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
      // RDS certs are signed by Amazon's CA, not in the Node.js trust store.
      // Points to the CA bundle downloaded by afterBundling hook below.
      // Lambda bundles are extracted to /var/task/ at runtime.
      NODE_EXTRA_CA_CERTS: "/var/task/rds-global-bundle.pem",
    },
    bundling: {
      minify: true,
      sourceMap: true,
      // Download the RDS CA bundle into the Lambda deployment package
      // so Node.js can verify RDS certificates via NODE_EXTRA_CA_CERTS.
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (_inputDir: string, outputDir: string) => [
          `curl -sfo ${outputDir}/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`,
        ],
      },
    },
  });

  props.appDbSecret.grantRead(fn);
  fn.addEnvironment("DB_SECRET_ARN", props.appDbSecret.secretArn);
  fn.addEnvironment("DB_HOST", props.db.dbInstanceEndpointAddress);
  fn.addEnvironment("DB_NAME", "tracker");

  // EventBridge: daily at 08:00 UTC
  new events.Rule(scope, "FxSchedule", {
    schedule: events.Schedule.cron({ hour: "8", minute: "0" }),
    targets: [new events_targets.LambdaFunction(fn)],
  });

  return { fxFetcher: fn };
}
