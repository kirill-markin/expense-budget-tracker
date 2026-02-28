import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import { networking } from "./networking";
import { auth } from "./auth";
import { database } from "./database";
import { compute } from "./compute";
import { ingress } from "./ingress";
import { fxFetcher } from "./fx-fetcher";
import { monitoring } from "./monitoring";
import { ciCd } from "./ci-cd";
import { backupPlan } from "./backup";
import { outputs } from "./outputs";

export class ExpenseBudgetTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Context parameters (domainName, certificateArn, region validated in bin/app.ts) ---
    const baseDomain = this.node.tryGetContext("domainName") as string;
    const alertEmail = this.node.tryGetContext("alertEmail") as string;
    const certificateArn = this.node.tryGetContext("certificateArn") as string;
    const githubRepo = this.node.tryGetContext("githubRepo") as string;
    const authCertificateArn = this.node.tryGetContext("authCertificateArn") as string;

    const appDomain = `app.${baseDomain}`;
    const callbackUrl = `https://${appDomain}/oauth2/idpresponse`;
    const authDomain = `auth.${baseDomain}`;

    // --- TLS Certificate (pre-created Cloudflare Origin Cert imported into ACM) ---
    const certificate = acm.Certificate.fromCertificateArn(
      this, "Certificate", certificateArn,
    );

    const net = networking(this);
    const authResult = auth(this, { appDomain, callbackUrl, authCertificateArn, authDomain });
    const dbResult = database(this, { vpc: net.vpc, dbSg: net.dbSg });
    const comp = compute(this, {
      vpc: net.vpc,
      ecsSg: net.ecsSg,
      db: dbResult.db,
      appDbSecret: dbResult.appDbSecret,
      openaiApiKeySecret: dbResult.openaiApiKeySecret,
      anthropicApiKeySecret: dbResult.anthropicApiKeySecret,
      authDomain,
      userPoolClientId: authResult.userPoolClient.userPoolClientId,
      appDomain,
    });
    const ing = ingress(this, {
      vpc: net.vpc,
      albSg: net.albSg,
      certificate,
      webService: comp.webService,
      userPool: authResult.userPool,
      userPoolClient: authResult.userPoolClient,
      userPoolDomain: authResult.userPoolDomain,
      baseDomain,
      appDomain,
    });
    const fx = fxFetcher(this, {
      vpc: net.vpc,
      lambdaSg: net.lambdaSg,
      db: dbResult.db,
      appDbSecret: dbResult.appDbSecret,
    });
    const mon = monitoring(this, {
      alertEmail,
      alb: ing.alb,
      webService: comp.webService,
      cluster: comp.cluster,
      db: dbResult.db,
      fxFetcher: fx.fxFetcher,
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
      userPoolDomain: authResult.userPoolDomain,
      alertTopic: mon.alertTopic,
      accessLogsBucket: ing.accessLogsBucket,
      cluster: comp.cluster,
      webService: comp.webService,
      migrateTaskDef: comp.migrateTaskDef,
      migrateSg: net.migrateSg,
      fxFetcher: fx.fxFetcher,
    });
  }
}
