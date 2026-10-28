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
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  AGENT_API_KEY_ENV_VAR_NAME,
  API_KEY_AUTHORIZATION_SCHEME,
  MISSING_API_KEY_CODE,
  MISSING_API_KEY_INSTRUCTIONS,
  MISSING_API_KEY_MESSAGE,
  buildErrorEnvelope,
} from "@expense-budget-tracker/agent-shared";

export interface ApiGatewayProps {
  authorizerFn: lambda.Function;
  sqlApiFn: lambda.Function;
  baseDomain: string;
  apiCertificateArn: string | undefined;
}

export interface ApiGatewayResult {
  restApi: apigw.RestApi;
  authorizerFn: lambda.Function;
  sqlApiFn: lambda.Function;
}

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
 *
 * Both bodies become Velocity templates, which silently strip an undefined
 * reference such as `$SOME_VAR` instead of rendering it, and render a
 * backslash escape verbatim. Name environment variables bare in this text.
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
  `Either the request header is not exactly ${API_KEY_AUTHORIZATION_SCHEME}, or the key is invalid or revoked. Check the header first; if it is correct, get a new key through the onboarding in GET ${apiBaseUrl}/, then store it in ${AGENT_API_KEY_ENV_VAR_NAME} and send it in that header.`,
  "api_key_not_accepted",
  "API key not accepted",
));

export function apiGateway(scope: Construct, props: ApiGatewayProps): ApiGatewayResult {
  const { authorizerFn, sqlApiFn } = props;
  const publicApiBaseUrl = `https://api.${props.baseDomain}/v1`;

  const accessLogGroup = new logs.LogGroup(scope, "SqlApiAccessLogGroup", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const stageName = "v1";
  const restApi = new apigw.RestApi(scope, "SqlRestApi", {
    restApiName: "expense-tracker-sql-api",
    description: "SQL API for machine clients (LLM agents, scripts)",
    deployOptions: {
      stageName,
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

  const authorizer = new apigw.TokenAuthorizer(scope, "SqlApiAuth", {
    handler: authorizerFn,
    identitySource: "method.request.header.Authorization",
    // Disable API Gateway authorizer caching so key revocation takes effect
    // on the next request instead of after a cache window expires.
    resultsCacheTtl: cdk.Duration.seconds(0),
  });

  const sqlIntegration = new apigw.Integration({
    type: apigw.IntegrationType.AWS_PROXY,
    integrationHttpMethod: "POST",
    uri: `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}:lambda:path/2015-03-31/functions/${sqlApiFn.functionArn}/invocations`,
  });

  restApi.root.addMethod("GET", sqlIntegration);

  const agentResource = restApi.root.addResource("agent");
  agentResource.addMethod("GET", sqlIntegration);

  restApi.root.addResource("openapi.json").addMethod("GET", sqlIntegration);
  restApi.root.addResource("swagger.json").addMethod("GET", sqlIntegration);

  const meResource = restApi.root.addResource("me");
  meResource.addMethod("GET", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  const workspacesResource = restApi.root.addResource("workspaces");
  workspacesResource.addMethod("GET", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });
  workspacesResource.addMethod("POST", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  workspacesResource
    .addResource("{workspaceId}")
    .addResource("select")
    .addMethod("POST", sqlIntegration, {
      authorizer,
      authorizationType: apigw.AuthorizationType.CUSTOM,
    });

  const schemaResource = restApi.root.addResource("schema");
  schemaResource.addMethod("GET", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  const sqlResource = restApi.root.addResource("sql");
  sqlResource.addMethod("POST", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });
  sqlResource.addResource("query").addMethod("POST", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });
  sqlResource.addResource("execute").addMethod("POST", sqlIntegration, {
    authorizer,
    authorizationType: apigw.AuthorizationType.CUSTOM,
  });

  // Keep these construct identities: replacement grants can exceed Lambda's policy-size limit.
  for (const method of restApi.methods) {
    const imagePermission = new lambda.CfnPermission(method, "ImageInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: sqlApiFn.functionArn,
      principal: "apigateway.amazonaws.com",
      sourceArn: restApi.arnForExecuteApi(
        method.httpMethod,
        method.resource.path.replace(/\{[^}]*\}/g, "*"),
        stageName,
      ),
    });
    const imageTestPermission = new lambda.CfnPermission(method, "ImageTestInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: sqlApiFn.functionArn,
      principal: "apigateway.amazonaws.com",
      sourceArn: method.testMethodArn,
    });
    const cfnMethod = method.node.defaultChild as apigw.CfnMethod;
    cfnMethod.addDependency(imagePermission);
    cfnMethod.addDependency(imageTestPermission);
  }

  restApi.addUsagePlan("SqlApiUsagePlan", {
    name: "sql-api-default",
    description: "Default usage plan for SQL API keys",
    throttle: { rateLimit: 10, burstLimit: 20 },
    quota: { limit: 10_000, period: apigw.Period.DAY },
    apiStages: [{ api: restApi, stage: restApi.deploymentStage }],
  });

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
