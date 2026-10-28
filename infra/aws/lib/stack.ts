import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { networking } from "./networking";
import { auth } from "./auth";
import { customEmailSenderKey } from "./custom-email-sender";
import { database } from "./database";
import { secrets } from "./secrets";
import { chatFilesBucket } from "./chat-files-bucket";
import { compute } from "./compute";
import { ingress } from "./ingress";
import { fxFetcher } from "./fx-fetcher";
import { apiGateway } from "./api-gateway";
import { mcpGateway } from "./mcp-gateway";
import { monitoring } from "./monitoring";
import { ciCd } from "./ci-cd";
import { backupPlan } from "./backup";
import { outputs } from "./outputs";
import { lambdaImageCandidates, lambdaImageCode } from "./lambda-image-candidates";

function getOptionalContextValue(stack: cdk.Stack, key: string): string | undefined {
  const value = stack.node.tryGetContext(key);
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue === "" ? undefined : trimmedValue;
}

export class ExpenseBudgetTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Context parameters (domainName, certificateArn, region validated in bin/app.ts) ---
    const baseDomain = this.node.tryGetContext("domainName") as string;
    const alertEmail = this.node.tryGetContext("alertEmail") as string;
    const certificateArn = this.node.tryGetContext("certificateArn") as string;
    const githubRepo = this.node.tryGetContext("githubRepo") as string;
    const apiCertificateArn = this.node.tryGetContext("apiCertificateArn") as string | undefined;
    const mcpCertificateArn = getOptionalContextValue(this, "mcpCertificateArn");
    const langfuseBaseUrl = this.node.tryGetContext("langfuseBaseUrl") as string | undefined
      ?? "https://cloud.langfuse.com";
    const demoEmailDostip = this.node.tryGetContext("demoEmailDostip") as string | undefined ?? "";
    const originSharedSecret = this.node.tryGetContext("originSharedSecret") as string | undefined ?? "";
    const resendApiKeySecretArn = getOptionalContextValue(this, "resendApiKeySecretArn");
    const resendSenderEmail = getOptionalContextValue(this, "resendSenderEmail");

    const appDomain = `app.${baseDomain}`;
    const authDomain = `auth.${baseDomain}`;

    // --- TLS Certificate (pre-created Cloudflare Origin Cert imported into ACM) ---
    const certificate = acm.Certificate.fromCertificateArn(
      this, "Certificate", certificateArn,
    );

    const net = networking(this);
    const dbResult = database(this, { vpc: net.vpc, dbSg: net.dbSg });
    const sec = secrets(this);
    const chatFiles = chatFilesBucket(this, { appDomain });
    if (resendApiKeySecretArn === undefined) {
      throw new Error("resendApiKeySecretArn is required for Cognito email delivery");
    }
    if (resendSenderEmail === undefined) {
      throw new Error("resendSenderEmail is required for Cognito email delivery");
    }
    const senderKey = customEmailSenderKey(this, resendApiKeySecretArn);
    const images = lambdaImageCandidates(this, {
      vpc: net.vpc,
      lambdaSg: net.lambdaSg,
      db: dbResult.db,
      appDbSecret: dbResult.appDbSecret,
      workerDbSecret: dbResult.workerDbSecret,
      chatFilesBucket: chatFiles.chatFilesBucket,
      customEmailSenderKey: senderKey,
      resendApiKeySecretArn,
      resendSenderEmail,
      baseDomain,
    }, lambdaImageCode);
    const authResult = auth(this, {
      preSignUpFn: images.signup,
      customEmailSenderFn: images.email,
      customEmailSenderKey: senderKey,
    });
    const comp = compute(this, {
      vpc: net.vpc,
      ecsSg: net.ecsSg,
      db: dbResult.db,
      chatFilesBucket: chatFiles.chatFilesBucket,
      chatSandboxFn: images.sandbox,
      appDbSecret: dbResult.appDbSecret,
      authDbSecret: dbResult.authDbSecret,
      workerDbSecret: dbResult.workerDbSecret,
      sessionEncryptionKeySecret: sec.sessionEncryptionKeySecret,
      openaiApiKeySecret: sec.openaiApiKeySecret,
      langfusePublicKeySecret: sec.langfusePublicKeySecret,
      langfuseSecretKeySecret: sec.langfuseSecretKeySecret,
      userPoolId: authResult.userPool.userPoolId,
      userPoolArn: authResult.userPool.userPoolArn,
      userPoolClientId: authResult.userPoolClient.userPoolClientId,
      appDomain,
      authDomain,
      langfuseBaseUrl,
      demoEmailDostip,
      demoPasswordSecret: demoEmailDostip !== "" ? sec.demoPasswordSecret : null,
    });
    const ing = ingress(this, {
      vpc: net.vpc,
      albSg: net.albSg,
      certificate,
      webService: comp.webService,
      authService: comp.authService,
      baseDomain,
      appDomain,
      authDomain,
      originSharedSecret,
    });

    const fx = fxFetcher(this, {
      fxFetcherFn: images.fx,
    });
    const api = apiGateway(this, {
      authorizerFn: images.authorizer,
      sqlApiFn: images.api,
      baseDomain,
      apiCertificateArn,
    });
    const mcp = mcpGateway(this, {
      mcpFn: images.mcp,
      baseDomain,
      mcpCertificateArn,
    });
    const mon = monitoring(this, {
      alertEmail,
      alb: ing.alb,
      webTargetGroup: ing.webTargetGroup,
      webLogGroup: comp.webLogGroup,
      authLogGroup: comp.authLogGroup,
      webAclName: ing.webAclName,
      webService: comp.webService,
      cluster: comp.cluster,
      db: dbResult.db,
      fxFetcher: fx.fxFetcher,
      restApi: api.restApi,
      authorizerFn: api.authorizerFn,
      sqlApiFn: api.sqlApiFn,
      mcpHttpApi: mcp.httpApi,
      mcpFn: mcp.mcpFn,
      chatSandboxFn: images.sandbox,
      customEmailSenderFn: images.email,
    });
    ciCd(this, {
      stackId: this.stackId,
      webService: comp.webService,
      migrateTaskDef: comp.migrateTaskDef,
      migrateLogGroup: comp.migrateLogGroup,
      cluster: comp.cluster,
      fxFetcher: fx.fxFetcher,
      githubRepo,
    });
    backupPlan(this, { db: dbResult.db });
    outputs(this, {
      appDomain,
      alb: ing.alb,
      db: dbResult.db,
      appDbSecret: dbResult.appDbSecret,
      userPool: authResult.userPool,
      alertTopic: mon.alertTopic,
      accessLogsBucket: ing.accessLogsBucket,
      chatFilesBucket: chatFiles.chatFilesBucket,
      cluster: comp.cluster,
      webService: comp.webService,
      migrateTaskDef: comp.migrateTaskDef,
      migrateSg: net.migrateSg,
      fxFetcher: fx.fxFetcher,
      restApi: api.restApi,
      authorizerFn: api.authorizerFn,
      sqlApiFn: api.sqlApiFn,
      mcpHttpApi: mcp.httpApi,
      mcpFn: mcp.mcpFn,
      mcpCustomDomainTarget: mcp.customDomainTarget,
      mcpUrl: `https://mcp.${baseDomain}/mcp`,
    });
  }
}
