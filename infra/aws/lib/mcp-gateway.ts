import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2_integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { SQL_API_DB_POOL_MAX_CONNECTIONS } from "@expense-budget-tracker/agent-shared";
import { MCP_SQL_STATEMENT_TIMEOUT_MS } from "@expense-budget-tracker/agent-shared/sql-policy";
import { Construct } from "constructs";

export interface McpGatewayProps {
  mcpFn: lambda.Function;
  baseDomain: string;
  mcpCertificateArn: string | undefined;
}

export interface McpGatewayResult {
  httpApi: apigwv2.HttpApi;
  httpStage: apigwv2.HttpStage;
  mcpFn: lambda.Function;
  customDomainTarget: string | undefined;
}

export const MCP_TIMEOUT_BUDGET = {
  requestExecutionMs: MCP_SQL_STATEMENT_TIMEOUT_MS,
  integrationSeconds: 29,
  lambdaSeconds: 35,
} as const;

const MCP_DB_SAFE_RESERVED_CONCURRENCY = 20;
const MCP_HTTP_API_BURST_LIMIT = 10;
const MCP_HTTP_API_RATE_LIMIT = 5;

export const MCP_CAPACITY_BUDGET = {
  approximateRdsMaxConnections: 85,
  maxConnectionsPerExecutionEnvironment: SQL_API_DB_POOL_MAX_CONNECTIONS,
  reservedConcurrentExecutions: MCP_DB_SAFE_RESERVED_CONCURRENCY,
  throttlingBurstLimit: MCP_HTTP_API_BURST_LIMIT,
  throttlingRateLimit: MCP_HTTP_API_RATE_LIMIT,
} as const;

export const createMcpHttpAccessLogFormat = (): apigw.AccessLogFormat =>
  apigw.AccessLogFormat.custom(JSON.stringify({
    requestId: apigw.AccessLogField.contextRequestId(),
    apiId: apigw.AccessLogField.contextApiId(),
    domainName: apigw.AccessLogField.contextDomainName(),
    stage: apigw.AccessLogField.contextStage(),
    httpMethod: apigw.AccessLogField.contextHttpMethod(),
    routeKey: apigw.AccessLogField.contextRouteKey(),
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

export const addMcpHttpApiRoutes = (
  httpApi: apigwv2.HttpApi,
  integration: apigwv2.HttpRouteIntegration,
): ReadonlyArray<apigwv2.HttpRoute> => [
  ...httpApi.addRoutes({
    path: "/mcp",
    methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
    integration,
  }),
  ...httpApi.addRoutes({
    path: "/.well-known/oauth-protected-resource/mcp",
    methods: [apigwv2.HttpMethod.GET],
    integration,
  }),
];

export const createMcpHttpApiCustomDomain = (
  scope: Construct,
  mcpDomainName: string,
  certificate: acm.ICertificate,
  httpApi: apigwv2.HttpApi,
  httpStage: apigwv2.HttpStage,
): apigwv2.DomainName => {
  const domain = new apigwv2.DomainName(scope, "McpApiDomain", {
    domainName: mcpDomainName,
    certificate,
    endpointType: apigwv2.EndpointType.REGIONAL,
  });
  new apigwv2.ApiMapping(scope, "McpApiMapping", {
    api: httpApi,
    domainName: domain,
    stage: httpStage,
  });
  return domain;
};

export function mcpGateway(scope: Construct, props: McpGatewayProps): McpGatewayResult {
  const mcpDomainName = `mcp.${props.baseDomain}`;
  const { mcpFn } = props;

  const httpApi = new apigwv2.HttpApi(scope, "McpHttpApi", {
    apiName: "expense-tracker-mcp-http-api",
    description: "Stateless Streamable HTTP MCP API",
    createDefaultStage: false,
    disableExecuteApiEndpoint: true,
  });
  const integration = new apigwv2_integrations.HttpLambdaIntegration(
    "McpHttpLambdaIntegration",
    mcpFn,
    {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      timeout: cdk.Duration.seconds(MCP_TIMEOUT_BUDGET.integrationSeconds),
    },
  );
  addMcpHttpApiRoutes(httpApi, integration);

  const accessLogGroup = new logs.LogGroup(scope, "McpApiAccessLogGroup", {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const httpStage = new apigwv2.HttpStage(scope, "McpHttpApiStage", {
    httpApi,
    stageName: "$default",
    autoDeploy: true,
    throttle: {
      burstLimit: MCP_CAPACITY_BUDGET.throttlingBurstLimit,
      rateLimit: MCP_CAPACITY_BUDGET.throttlingRateLimit,
    },
    detailedMetricsEnabled: true,
    accessLogSettings: {
      destination: new apigwv2.LogGroupLogDestination(accessLogGroup),
      format: createMcpHttpAccessLogFormat(),
    },
  });

  if (props.mcpCertificateArn === undefined) {
    return { httpApi, httpStage, mcpFn, customDomainTarget: undefined };
  }

  const certificate = acm.Certificate.fromCertificateArn(
    scope,
    "McpCertificate",
    props.mcpCertificateArn,
  );
  const domain = createMcpHttpApiCustomDomain(
    scope,
    mcpDomainName,
    certificate,
    httpApi,
    httpStage,
  );

  return {
    httpApi,
    httpStage,
    mcpFn,
    customDomainTarget: domain.regionalDomainName,
  };
}
