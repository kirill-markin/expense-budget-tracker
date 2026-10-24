import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface FxFetcherProps {
  fxFetcherFn: lambda.Function;
}

export interface FxFetcherResult {
  fxFetcher: lambda.Function;
}

export function fxFetcher(scope: Construct, props: FxFetcherProps): FxFetcherResult {
  const schedule = new events.Rule(scope, "FxSchedule", {
    schedule: events.Schedule.cron({ hour: "8", minute: "0" }),
  });
  schedule.addTarget(new events_targets.LambdaFunction(props.fxFetcherFn));

  return { fxFetcher: props.fxFetcherFn };
}
