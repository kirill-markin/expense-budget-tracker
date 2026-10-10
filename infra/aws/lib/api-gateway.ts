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
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "path";
import {
  AGENT_API_KEY_ENV_VAR_NAME,
  API_KEY_AUTHORIZATION_SCHEME,
  MISSING_API_KEY_CODE,
  MISSING_API_KEY_INSTRUCTIONS,
  MISSING_API_KEY_MESSAGE,
  buildErrorEnvelope,
} from "@expense-budget-tracker/agent-shared";

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

export const createSqlApiAccessLogFormat = (): apigw.AccessLogFormat =>
  apigw.AccessLogFormat.custom(JSON.stringify({
    requestId: apigw.AccessLogField.contextRequestId(),
    httpMethod: apigw.AccessLogField.contextHttpMethod(),
    resourcePath: apigw.AccessLogField.contextResourcePath(),
    path: apigw.AccessLogField.contextPath(),
    status: apigw.AccessLogField.contextStatus(),
    protocol: apigw.AccessLogField.contextProtocol(),
    responseLength: apigw.AccessLogField.contextResponseLength(),
    requestTime: apigw.AccessLogField.contextRequestTime(),
    ip: apigw.AccessLogField.contextIdentitySourceIp(),
    userAgent: apigw.AccessLogField.contextIdentityUserAgent(),
    integrationStatus: apigw.AccessLogField.contextIntegrationStatus(),
    integrationLatency: apigw.AccessLogField.contextIntegrationLatency(),
    integrationError: apigw.AccessLogField.contextIntegrationErrorMessage(),
    errorMessage: apigw.AccessLogField.contextErrorMessage(),
  }));

/**
 * Credential refusals API Gateway answers on its own, before the SQL Lambda
 * runs, rendered as the agent envelope every other /v1 response returns.
 *
 * A request with no Authorization header at all never reaches the authorizer,
 * so this mirrors the missing_api_key branch in apps/sql-api/src/machineApi.ts
 * through the shared constants; that branch still answers for the container
 * runtime that serves the same routes without a gateway in front. A header
 * that is present but unparseable does reach the authorizer and is refused by
 * the ACCESS_DENIED template below.
 */
export const createMissingApiKeyResponseBody = (): string => JSON.stringify(buildErrorEnvelope(
  {},
  [],
  MISSING_API_KEY_INSTRUCTIONS,
  MISSING_API_KEY_CODE,
  MISSING_API_KEY_MESSAGE,
));

/**
 * The authorizer denied the request, which covers both a header that does not
 * use the ApiKey scheme and a key that is invalid or revoked. Repeating the
 * same request cannot succeed, so the instruction names both causes in the
 * order the caller can check them.
 */
export const createRejectedApiKeyResponseBody = (apiBaseUrl: string): string => JSON.stringify(buildErrorEnvelope(
  {},
  [],
  `Either the request header is not exactly ${API_KEY_AUTHORIZATION_SCHEME}, or the key is invalid or revoked. Check the header first; if it is correct, get a new key through the onboarding in GET ${apiBaseUrl}/, then send Authorization: ApiKey $${AGENT_API_KEY_ENV_VAR_NAME}.`,
  "api_key_not_accepted",
  "API key not accepted",
));

export function apiGateway(scope: Construct, props: ApiGatewayProps): ApiGatewayResult {
  const sqlApiEntry = path.join(__dirname, "../../../apps/sql-api/src");
  const publicApiBaseUrl = `https://api.${props.baseDomain}/v1`;

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
  sqlApiFn.addEnvironment("PUBLIC_API_BASE_URL", publicApiBaseUrl);
  sqlApiFn.addEnvironment("PUBLIC_AUTH_BASE_URL", `https://auth.${props.baseDomain}`);

  // --- REST API ---
  const accessLogGroup = new logs.LogGroup(scope, "SqlApiAccessLogGroup", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const restApi = new apigw.RestApi(scope, "SqlRestApi", {
    restApiName: "expense-tracker-sql-api",
    description: "SQL API for machine clients (LLM agents, scripts)",
    deployOptions: {
      stageName: "v1",
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
      accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
      accessLogFormat: createSqlApiAccessLogFormat(),
    },
  });

  restApi.addGatewayResponse("SqlApiUnauthorizedResponse", {
    type: apigw.ResponseType.UNAUTHORIZED,
    statusCode: "401",
    templates: { "application/json": createMissingApiKeyResponseBody() },
  });

  restApi.addGatewayResponse("SqlApiAccessDeniedResponse", {
    type: apigw.ResponseType.ACCESS_DENIED,
    statusCode: "403",
    templates: { "application/json": createRejectedApiKeyResponseBody(publicApiBaseUrl) },
  });

  // --- Token Authorizer ---
  const authorizer = new apigw.TokenAuthorizer(scope, "SqlApiAuth", {
    handler: authorizerFn,
    identitySource: "method.request.header.Authorization",
    // Disable API Gateway authorizer caching so key revocation takes effect
    // on the next request instead of after a cache window expires.
    resultsCacheTtl: cdk.Duration.seconds(0),
  });

  restApi.root.addMethod("GET", new apigw.LambdaIntegration(sqlApiFn));

  const agentResource = restApi.root.addResource("agent");
  agentResource.addMethod("GET", new apigw.LambdaIntegration(sqlApiFn));

  restApi.root.addResource("openapi.json").addMethod("GET", new apigw.LambdaIntegration(sqlApiFn));
  restApi.root.addResource("swagger.json").addMethod("GET", new apigw.LambdaIntegration(sqlApiFn));

  const meResource = restApi.root.addResource("me");
  meResource.addMethod("GET", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  const workspacesResource = restApi.root.addResource("workspaces");
  workspacesResource.addMethod("GET", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });
  workspacesResource.addMethod("POST", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  workspacesResource
    .addResource("{workspaceId}")
    .addResource("select")
    .addMethod("POST", new apigw.LambdaIntegration(sqlApiFn), {
      authorizer,
      authorizationType: apigw.AuthorizationType.CUSTOM,
    });

  const schemaResource = restApi.root.addResource("schema");
  schemaResource.addMethod("GET", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  // --- Route: POST /sql ---
  const sqlResource = restApi.root.addResource("sql");
  sqlResource.addMethod("POST", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });
  sqlResource.addResource("query").addMethod("POST", new apigw.LambdaIntegration(sqlApiFn), {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });
  sqlResource.addResource("execute").addMethod("POST", new apigw.LambdaIntegration(sqlApiFn), {
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
      basePath: "v1",
    });

    new cdk.CfnOutput(scope, "ApiCustomDomain", {
      value: domain.domainNameAliasDomainName,
      description: "API Gateway custom domain — point Cloudflare CNAME here",
    });
  }

  return { restApi, authorizerFn, sqlApiFn };
}
