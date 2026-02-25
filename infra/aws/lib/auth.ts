import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";

export interface AuthProps {
  appDomain: string;
  callbackUrl: string;
  authCertificateArn: string;
  authDomain: string;
}

export interface AuthResult {
  userPool: cognito.UserPool;
  userPoolDomain: cognito.UserPoolDomain;
  userPoolClient: cognito.UserPoolClient;
}

export function auth(scope: Construct, props: AuthProps): AuthResult {
  // --- Cognito User Pool ---
  // Open registration: any user can sign up with email.
  // Each user gets an isolated workspace via RLS — no shared data.
  const userPool = new cognito.UserPool(scope, "UserPool", {
    userPoolName: "expense-tracker-users",
    selfSignUpEnabled: true,
    signInAliases: { email: true },
    autoVerify: { email: true },
    passwordPolicy: {
      minLength: 12,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: false,
    },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const authCertificate = acm.Certificate.fromCertificateArn(
    scope, "AuthCertificate", props.authCertificateArn,
  );
  const userPoolDomain = userPool.addDomain("CognitoDomain", {
    customDomain: { domainName: props.authDomain, certificate: authCertificate },
  });

  const userPoolClient = userPool.addClient("AlbClient", {
    generateSecret: true,
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      callbackUrls: [props.callbackUrl],
      logoutUrls: [`https://${props.appDomain}/`],
    },
    supportedIdentityProviders: [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ],
  });

  return { userPool, userPoolDomain, userPoolClient };
}
