import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2_integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambda_nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { SQL_API_DB_POOL_MAX_CONNECTIONS } from "@expense-budget-tracker/agent-shared";
import { MCP_SQL_STATEMENT_TIMEOUT_MS } from "@expense-budget-tracker/agent-shared/sql-policy";
import { Construct } from "constructs";

export interface McpGatewayProps {
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  db: rds.DatabaseInstance;
  appDbSecret: secretsmanager.Secret;
  baseDomain: string;
  mcpCertificateArn: string | undefined;
}

export interface McpGatewayResult {
  httpApi: apigwv2.HttpApi;
  httpStage: apigwv2.HttpStage;
  mcpFn: lambda_nodejs.NodejsFunction;
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
): void => {
  httpApi.addRoutes({
    path: "/mcp",
    methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
    integration,
  });
  httpApi.addRoutes({
    path: "/.well-known/oauth-protected-resource/mcp",
    methods: [apigwv2.HttpMethod.GET],
    integration,
  });
};

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

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const buildPemBundleValidationScript = (): string => shellQuote([
  'const { readFileSync } = require("node:fs");',
  'const { X509Certificate } = require("node:crypto");',
  "try {",
  '  const body = readFileSync(process.argv[1], "utf8");',
  "  const certificatePattern = /-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/gu;",
  "  const certificates = body.match(certificatePattern) ?? [];",
  '  if (certificates.length === 0) throw new Error("RDS CA response contains no PEM certificates");',
  "  if (body.replace(certificatePattern, \"\").trim() !== \"\") throw new Error(\"RDS CA response contains non-certificate content\");",
  "  for (const certificate of certificates) new X509Certificate(certificate);",
  "} catch (error) {",
  '  console.error(error instanceof Error ? error.message : "RDS CA response validation failed");',
  "  process.exit(1);",
  "}",
].join(" "));

export const buildRdsCaDownloadCommand = (outputDir: string): string => {
  const destination = shellQuote(path.join(outputDir, "rds-global-bundle.pem"));
  const temporaryDestination = shellQuote(path.join(outputDir, "rds-global-bundle.pem.download"));
  const errorDestination = shellQuote(path.join(outputDir, "rds-global-bundle.pem.error"));
  const downloadUrl = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";
  const validatePemBundle = buildPemBundleValidationScript();
  return [
    "attempt=1",
    "while [ \"$attempt\" -le 4 ]; do",
    `  rm -f ${temporaryDestination} ${errorDestination}`,
    "  http_status=none",
    "  curl_status=0",
    "  validation_status=not_run",
    `  if http_status=$(curl --silent --show-error --connect-timeout 10 --max-time 60 --output ${temporaryDestination} --write-out '%{http_code}' ${downloadUrl} 2>${errorDestination}); then`,
    "    if [ \"$http_status\" = \"200\" ]; then",
    `      if node -e ${validatePemBundle} ${temporaryDestination} 2>>${errorDestination}; then`,
    `        mv ${temporaryDestination} ${destination}`,
    `        rm -f ${errorDestination}`,
    "        exit 0",
    "      else",
    "        validation_status=$?",
    "      fi",
    "    fi",
    "  else",
    "    curl_status=$?",
    "  fi",
    `  response_body=$(head -c 2000 ${temporaryDestination} 2>/dev/null | tr '\\n' ' ')`,
    `  transport_error=$(head -c 2000 ${errorDestination} 2>/dev/null | tr '\\n' ' ')`,
    `  rm -f ${temporaryDestination} ${errorDestination}`,
    "  if [ \"$attempt\" -eq 4 ]; then",
    `    echo \"ERROR: RDS CA bundle download failed after 4 attempts; url=${downloadUrl}; expected_http_status=200; curl_status=$curl_status; http_status=\${http_status:-none}; validation_status=$validation_status; response=\${response_body:-empty}; transport_or_validation_error=\${transport_error:-none}\" >&2`,
    "    exit 1",
    "  fi",
    `  echo \"WARNING: RDS CA bundle download attempt $attempt/4 failed; url=${downloadUrl}; expected_http_status=200; curl_status=$curl_status; http_status=\${http_status:-none}; validation_status=$validation_status; response=\${response_body:-empty}; transport_or_validation_error=\${transport_error:-none}; retrying in 2 seconds\" >&2`,
    "  sleep 2",
    "  attempt=$((attempt + 1))",
    "done",
  ].join("\n");
};

const lambdaBundling: lambda_nodejs.BundlingOptions = {
  minify: true,
  sourceMap: true,
  commandHooks: {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (_inputDir: string, outputDir: string) => [
      buildRdsCaDownloadCommand(outputDir),
    ],
  },
};

export function mcpGateway(scope: Construct, props: McpGatewayProps): McpGatewayResult {
  const mcpDomainName = `mcp.${props.baseDomain}`;
  const resourceUrl = `https://${mcpDomainName}/mcp`;
  const mcpFn = new lambda_nodejs.NodejsFunction(scope, "McpHandler", {
    entry: path.join(__dirname, "../../../apps/sql-api/src/mcp-handler.ts"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_24_X,
    timeout: cdk.Duration.seconds(MCP_TIMEOUT_BUDGET.lambdaSeconds),
    memorySize: 256,
    // Reserved concurrency, independently of the HTTP API token bucket, caps
    // 20 execution environments. Their one-connection pools can open at most 20
    // of roughly 85 RDS connections, leaving capacity for about 65 more.
    reservedConcurrentExecutions: MCP_CAPACITY_BUDGET.reservedConcurrentExecutions,
    vpc: props.vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [props.lambdaSg],
    environment: {
      NODE_EXTRA_CA_CERTS: "/var/task/rds-global-bundle.pem",
      DB_SECRET_ARN: props.appDbSecret.secretArn,
      DB_HOST: props.db.dbInstanceEndpointAddress,
      DB_NAME: "tracker",
      OAUTH_ISSUER: `https://auth.${props.baseDomain}`,
      OAUTH_RESOURCE: resourceUrl,
    },
    bundling: lambdaBundling,
  });
  props.appDbSecret.grantRead(mcpFn);

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
