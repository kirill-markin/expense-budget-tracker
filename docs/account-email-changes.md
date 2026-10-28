# Account Email Changes

An account email can change in exactly one way: a deliberate admin action against Cognito, announced to the old address first. There is no in-product change-email flow.

## Why users cannot do it themselves

The app client's write allowlist in `infra/aws/lib/auth.ts` excludes `email`, so `UpdateUserAttributes` on it is rejected with `NotAuthorizedException: A client attempted to write unauthorized attribute`. The pool also requires verification before an email update takes effect, so the original address keeps working until a new one is verified.

Admin calls bypass the write allowlist outright. They bypass verification before update only when the same call also sets `email_verified=true`.

## Procedure

1. Email the old address first, stating the new address and when the change happens. The owner of the old address must be able to object to a change they did not request. This heads-up is manual: nothing notifies them automatically, and nothing detects or alerts on the change.
2. Resolve the pool id for the deployment:

```bash
aws cognito-idp list-user-pools --max-results 60 \
  --profile expense-tracker --region eu-central-1 \
  --query "UserPools[?Name=='expense-tracker-users'].Id"
```

3. Set both attributes in one call. `--username` takes the user's current email address or their `sub`:

```bash
aws cognito-idp admin-update-user-attributes \
  --user-pool-id <user-pool-id> \
  --username <current-email-or-sub> \
  --user-attributes Name=email,Value=<new-email> Name=email_verified,Value=true \
  --profile expense-tracker --region eu-central-1
```

Both attributes belong in the same call. Because the pool requires verification before an email update, a call that sets only `email` leaves the stored address on the old value and merely sends a verification code to the new one: the command succeeds and the change silently does not take effect. Setting `email_verified=true` alongside it writes the new address immediately.

## Downstream effect

The local `users.email` mirror is written from the verified ID token's `email` claim, so it follows on the first browser request made after the user's ID token expires, one hour at the token's default lifetime, and not at the moment of the admin call. Nothing reissues that token on a timer, so an account that makes no browser request keeps the previous address in `users.email` until it does.

If the new address already belongs to another Cognito user, the admin call itself fails with `AliasExistsException: An account with the given email already exists.` The unique `idx_users_email` can also refuse the mirror write when a stale `users` row still holds the new address; correct or clear that row. Accounts are never linked or merged automatically.
