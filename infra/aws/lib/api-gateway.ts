/**
 * API Gateway (REST API) for machine clients (LLM agents, scripts).
 *
 * Separate path from the browser stack (ALB + Cognito):
 *   Machine: Cloudflare → API Gateway → Lambda Authorizer → SQL Lambda → RDS
 *
 * Provides: per-key rate limiting (Usage Plans), auth at the gateway
 * (Lambda Authorizer with usageIdentifierKey), CloudWatch metrics, and a
 * clean separation for future machine-facing services.
 */

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import * as path from "path";

export interface ApiGatewayProps {
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  db: rds.DatabaseInstance;
  appDbSecret: cdk.aws_secretsmanager.Secret;
  baseDomain: string;
  apiCertificateArn: string | undefined;
}

export interface ApiGatewayResult {
  restApi: apigw.RestApi;
  authorizerFn: lambda_nodejs.NodejsFunction;
  sqlApiFn: lambda_nodejs.NodejsFunction;
}

const lambdaBundling: lambda_nodejs.BundlingOptions = {
  minify: true,
  sourceMap: true,
  commandHooks: {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (_inputDir: string, outputDir: string) => [
      `curl -sfo ${outputDir}/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`,
    ],
  },
};

const lambdaEnvBase: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: "/var/task/rds-global-bundle.pem",
};

export function apiGateway(scope: Construct, props: ApiGatewayProps): ApiGatewayResult {
  const sqlApiEntry = path.join(__dirname, "../../../apps/sql-api/src");

  // --- Lambda Authorizer ---
  const authorizerFn = new lambda_nodejs.NodejsFunction(scope, "SqlApiAuthorizer", {
    entry: path.join(sqlApiEntry, "authorizer.ts"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.seconds(10),
    memorySize: 256,
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.lambdaSg],
    environment: { ...lambdaEnvBase },
    bundling: lambdaBundling,
  });

  props.appDbSecret.grantRead(authorizerFn);
  authorizerFn.addEnvironment("DB_SECRET_ARN", props.appDbSecret.secretArn);
  authorizerFn.addEnvironment("DB_HOST", props.db.dbInstanceEndpointAddress);
  authorizerFn.addEnvironment("DB_NAME", "tracker");

  // --- SQL Executor Lambda ---
  const sqlApiFn = new lambda_nodejs.NodejsFunction(scope, "SqlApiHandler", {
    entry: path.join(sqlApiEntry, "handler.ts"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.seconds(35),
    memorySize: 256,
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.lambdaSg],
    environment: { ...lambdaEnvBase },
    bundling: lambdaBundling,
  });

  props.appDbSecret.grantRead(sqlApiFn);
  sqlApiFn.addEnvironment("DB_SECRET_ARN", props.appDbSecret.secretArn);
  sqlApiFn.addEnvironment("DB_HOST", props.db.dbInstanceEndpointAddress);
  sqlApiFn.addEnvironment("DB_NAME", "tracker");

  // --- REST API ---
  const restApi = new apigw.RestApi(scope, "SqlRestApi", {
    restApiName: "expense-tracker-sql-api",
    description: "SQL API for machine clients (LLM agents, scripts)",
    deployOptions: {
      stageName: "v1",
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
    },
  });

  // --- Token Authorizer ---
  const authorizer = new apigw.TokenAuthorizer(scope, "SqlApiAuth", {
    handler: authorizerFn,
    identitySource: "method.request.header.Authorization",
    resultsCacheTtl: cdk.Duration.minutes(5),
  });

  // --- Route: POST /sql ---
  const sqlResource = restApi.root.addResource("sql");
  sqlResource.addMethod("POST", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  // --- Usage Plan (per-key throttling via usageIdentifierKey) ---
  restApi.addUsagePlan("SqlApiUsagePlan", {
    name: "sql-api-default",
    description: "Default usage plan for SQL API keys",
    throttle: { rateLimit: 10, burstLimit: 20 },
    quota: { limit: 10_000, period: apigw.Period.DAY },
    apiStages: [{ api: restApi, stage: restApi.deploymentStage }],
  });

  // --- Custom domain (optional) ---
  if (props.apiCertificateArn) {
    const apiDomainName = `api.${props.baseDomain}`;
    const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
      scope, "ApiCertificate", props.apiCertificateArn,
    );

    const domain = restApi.addDomainName("SqlApiDomain", {
      domainName: apiDomainName,
      certificate,
      endpointType: apigw.EndpointType.REGIONAL,
    });

    new cdk.CfnOutput(scope, "ApiCustomDomain", {
      value: domain.domainNameAliasDomainName,
      description: "API Gateway custom domain — point Cloudflare CNAME here",
    });
  }

  return { restApi, authorizerFn, sqlApiFn };
}
