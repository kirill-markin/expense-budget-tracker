import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOtpSendDecision } from "./otpRateLimit.js";

test("evaluateOtpSendDecision returns allowed below all thresholds", () => {
  const decision = evaluateOtpSendDecision({
    emailPerMinute: 0,
    emailPerQuarterHour: 2,
    emailPerDay: 9,
    ipPerQuarterHour: 9,
    ipPerHour: 29,
    ipPerDay: 99,
    distinctEmailsPerHour: 4,
    distinctEmailsPerDay: 19,
  });

  assert.equal(decision, "allowed");
});

test("evaluateOtpSendDecision blocks at email thresholds", () => {
  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 1,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_email_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 3,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_email_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 10,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_email_limit",
  );
});

test("evaluateOtpSendDecision blocks at IP thresholds", () => {
  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 10,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 30,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 100,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );
});

test("evaluateOtpSendDecision blocks at distinct-email-per-IP thresholds", () => {
  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 5,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 20,
    }),
    "blocked_ip_limit",
  );
});
