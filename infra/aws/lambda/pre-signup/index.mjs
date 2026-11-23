/**
 * Cognito PreSignUp trigger. Self sign-up is off, so it runs only for
 * AdminCreateUser, where Cognito ignores these response flags; the auth
 * service sets email_verified and a permanent password itself.
 */
export const handler = async (event) => {
  event.response.autoConfirmUser = true;
  if (event.request.userAttributes.email) {
    event.response.autoVerifyEmail = true;
  }
  return event;
};
