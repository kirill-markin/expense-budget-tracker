import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2_integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import {
  addMcpHttpApiRoutes,
  buildRdsCaDownloadCommand,
  createMcpHttpAccessLogFormat,
  createMcpHttpApiCustomDomain,
  MCP_CAPACITY_BUDGET,
  MCP_TIMEOUT_BUDGET,
} from "./mcp-gateway";

type McpHttpApiTestResources = Readonly<{
  stack: cdk.Stack;
  httpApi: apigwv2.HttpApi;
  httpStage: apigwv2.HttpStage;
}>;

const createMcpHttpApiTestResources = (): McpHttpApiTestResources => {
  const stack = new cdk.Stack();
  const httpApi = new apigwv2.HttpApi(stack, "McpHttpApi", {
    apiName: "expense-tracker-mcp-http-api",
    createDefaultStage: false,
    disableExecuteApiEndpoint: true,
  });
  const fn = new lambda.Function(stack, "McpHandler", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromInline("exports.handler = async () => ({ statusCode: 200, body: '{}' });"),
  });
  const integration = new apigwv2_integrations.HttpLambdaIntegration(
    "McpHttpLambdaIntegration",
    fn,
    {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      timeout: cdk.Duration.seconds(MCP_TIMEOUT_BUDGET.integrationSeconds),
    },
  );
  addMcpHttpApiRoutes(httpApi, integration);
  const accessLogGroup = new logs.LogGroup(stack, "McpApiAccessLogGroup");
  const httpStage = new apigwv2.HttpStage(stack, "McpHttpApiStage", {
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
  return { stack, httpApi, httpStage };
};

const synthesizeMcpHttpApiTemplate = (): Template => {
  const resources = createMcpHttpApiTestResources();
  return Template.fromStack(resources.stack);
};

const synthesizeMcpHttpApiDomainTemplate = (): Template => {
  const resources = createMcpHttpApiTestResources();
  const certificate = acm.Certificate.fromCertificateArn(
    resources.stack,
    "McpCertificate",
    "arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
  );
  createMcpHttpApiCustomDomain(
    resources.stack,
    "mcp.example.com",
    certificate,
    resources.httpApi,
    resources.httpStage,
  );
  return Template.fromStack(resources.stack);
};

test("MCP HTTP API applies its conservative request-rate envelope", (): void => {
  assert.equal(MCP_CAPACITY_BUDGET.throttlingBurstLimit, 10);
  assert.equal(MCP_CAPACITY_BUDGET.throttlingRateLimit, 5);
});

test("MCP Lambda concurrency and pool ceiling preserve the RDS connection budget", (): void => {
  const maximumMcpConnections = MCP_CAPACITY_BUDGET.reservedConcurrentExecutions
    * MCP_CAPACITY_BUDGET.maxConnectionsPerExecutionEnvironment;
  const remainingConnectionCapacity = MCP_CAPACITY_BUDGET.approximateRdsMaxConnections
    - maximumMcpConnections;

  assert.equal(MCP_CAPACITY_BUDGET.reservedConcurrentExecutions, 20);
  assert.equal(MCP_CAPACITY_BUDGET.maxConnectionsPerExecutionEnvironment, 1);
  assert.equal(maximumMcpConnections, 20);
  assert.equal(remainingConnectionCapacity, 65);
});

test("MCP gateway uses HTTP API v2 with no default execute-api endpoint", (): void => {
  const template = synthesizeMcpHttpApiTemplate();

  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "expense-tracker-mcp-http-api",
    ProtocolType: "HTTP",
    DisableExecuteApiEndpoint: true,
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
    IntegrationType: "AWS_PROXY",
    PayloadFormatVersion: "2.0",
    TimeoutInMillis: 29_000,
  });
  template.resourceCountIs("AWS::ApiGateway::RestApi", 0);
});

test("MCP HTTP API exposes only the canonical transport and pathful metadata routes", (): void => {
  const template = synthesizeMcpHttpApiTemplate();
  const routes = template.findResources("AWS::ApiGatewayV2::Route");
  const routeKeys = Object.values(routes).map((route) => route.Properties.RouteKey).sort();

  assert.deepEqual(routeKeys, [
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /mcp",
    "POST /mcp",
  ]);
  assert.equal(routeKeys.includes("$default"), false);
  assert.equal(routeKeys.some((routeKey) => routeKey.includes("/v1")), false);
});

test("MCP HTTP API stage applies configured throttling, metrics, and safe access logs", (): void => {
  const template = synthesizeMcpHttpApiTemplate();

  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    AutoDeploy: true,
    DefaultRouteSettings: {
      DetailedMetricsEnabled: true,
      ThrottlingBurstLimit: 10,
      ThrottlingRateLimit: 5,
    },
    AccessLogSettings: {
      DestinationArn: Match.anyValue(),
      Format: Match.anyValue(),
    },
  });
  const format = createMcpHttpAccessLogFormat().toString();
  assert.match(format, /\$context\.requestId/u);
  assert.match(format, /\$context\.routeKey/u);
  assert.match(format, /\$context\.path/u);
  assert.equal(format.includes("$context.resourcePath"), false);
  assert.equal(format.includes("$context.extendedRequestId"), false);
  assert.equal(format.toLowerCase().includes("authorization"), false);
});

test("MCP HTTP API custom domain has one root mapping and regional Cloudflare target", (): void => {
  const template = synthesizeMcpHttpApiDomainTemplate();

  template.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
    DomainName: "mcp.example.com",
    DomainNameConfigurations: [{
      CertificateArn: "arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
      EndpointType: "REGIONAL",
    }],
  });
  const mappings = template.findResources("AWS::ApiGatewayV2::ApiMapping");
  assert.equal(Object.keys(mappings).length, 1);
  const mapping = Object.values(mappings)[0];
  assert.ok(mapping !== undefined);
  assert.equal(Object.hasOwn(mapping.Properties, "ApiMappingKey"), false);
});

test("MCP bundling accepts only an HTTP 200 valid PEM bundle before installation", (): void => {
  const command = buildRdsCaDownloadCommand("/tmp/mcp bundle");

  assert.match(command, /--connect-timeout 10/u);
  assert.match(command, /--max-time 60/u);
  assert.match(command, /--write-out '%\{http_code\}'/u);
  assert.match(command, /\[ "\$http_status" = "200" \]/u);
  assert.match(command, /X509Certificate/u);
  assert.match(command, /RDS CA response contains no PEM certificates/u);
  assert.match(command, /RDS CA response contains non-certificate content/u);
  assert.match(command, /response=\$\{response_body:-empty\}/u);
  assert.match(command, /transport_or_validation_error=\$\{transport_error:-none\}/u);
  assert.match(command, /attempt \$attempt\/4 failed/u);
  assert.match(command, /failed after 4 attempts/u);
  assert.match(command, /'\/tmp\/mcp bundle\/rds-global-bundle\.pem'/u);
  const statusCheckIndex = command.indexOf('    if [ "$http_status" = "200" ]');
  const validationIndex = command.indexOf("      if node -e ");
  const installIndex = command.indexOf("        mv ");
  assert.ok(statusCheckIndex >= 0);
  assert.ok(validationIndex > statusCheckIndex);
  assert.ok(installIndex > validationIndex);
});

test("MCP request, integration, and Lambda timeouts preserve response headroom", (): void => {
  assert.equal(MCP_TIMEOUT_BUDGET.requestExecutionMs, 20_000);
  assert.equal(MCP_TIMEOUT_BUDGET.integrationSeconds, 29);
  assert.equal(MCP_TIMEOUT_BUDGET.lambdaSeconds, 35);
  assert.ok(
    MCP_TIMEOUT_BUDGET.requestExecutionMs <= 25_000,
  );
  assert.ok(
    MCP_TIMEOUT_BUDGET.integrationSeconds * 1_000
      - MCP_TIMEOUT_BUDGET.requestExecutionMs >= 5_000,
  );
  assert.ok(
    MCP_TIMEOUT_BUDGET.lambdaSeconds
      - MCP_TIMEOUT_BUDGET.integrationSeconds >= 5,
  );
});
