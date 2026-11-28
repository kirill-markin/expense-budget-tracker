import assert from "node:assert/strict";
import test from "node:test";
import { handleCustomEmailSenderEvent } from "../lambda/custom-email-sender/index";

test("the authentication email sends matching English HTML and plaintext for legacy or invalid metadata", async (): Promise<void> => {
  for (const clientMetadata of [undefined, { locale: "unsupported" }, { locale: "en" }]) {
    const event = {
      triggerSource: "CustomEmailSender_Authentication",
      request: {
        code: "encrypted-otp",
        clientMetadata,
        userAttributes: { email: "mailbox@example.com" },
      },
    };
    let sends = 0;
    const result = await handleCustomEmailSenderEvent(event, {
      keyArn: "key-arn",
      keyId: "key-id",
      resendApiKeySecretArn: "secret-arn",
      resendFromEmail: "auth@example.com",
      resendFromName: "Expense Budget Tracker",
    }, {
      decryptCode: async (code) => {
        assert.equal(code, "encrypted-otp");
        return "12345678";
      },
      loadResendApiKey: async () => "test-api-key",
      fetchFn: async (url, options) => {
        sends += 1;
        assert.equal(url, "https://api.resend.com/emails");
        const body = options?.body;
        assert(typeof body === "string");
        const message = JSON.parse(body) as Readonly<{
          html: string;
          subject: string;
          text: string;
        }>;
        assert.match(message.html, /<div lang="en" dir="ltr"/u);
        assert.match(message.html, /12345678/u);
        assert.equal(message.subject, "Your Expense Budget Tracker sign-in code");
        assert.match(message.text, /continue in Expense Budget Tracker:\n\n12345678\n\nThis code expires/u);
        return Response.json({ id: "resend-message-id" });
      },
    });

    assert.equal(result, event);
    assert.equal(sends, 1);
  }
});
