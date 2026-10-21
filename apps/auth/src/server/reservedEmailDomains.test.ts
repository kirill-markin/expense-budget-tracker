import assert from "node:assert/strict";
import test from "node:test";
import { hasUndeliverableReservedDomain } from "./reservedEmailDomains.js";

type ReservedDomainCase = Readonly<{ email: string; reserved: boolean }>;

const reservedDomainCases: ReadonlyArray<ReservedDomainCase> = [
  { email: "demo@example.com", reserved: true },
  { email: "demo@example.org", reserved: true },
  { email: "demo@example.net", reserved: true },
  { email: "demo@test", reserved: true },
  { email: "demo@staging.test", reserved: true },
  { email: "demo@invalid", reserved: true },
  { email: "demo@mail.invalid", reserved: true },
  { email: "demo@localhost", reserved: true },
  { email: "demo@app.localhost", reserved: true },
  { email: "Demo@ExAmPlE.CoM", reserved: true },
  { email: "demo@example.com.", reserved: true },
  { email: "demo@example.community", reserved: false },
  { email: "demo@nottest.com", reserved: false },
  { email: "demo-without-a-separator", reserved: false },
];

test("every reserved domain rule is matched and deliverable look-alikes pass", (): void => {
  for (const domainCase of reservedDomainCases) {
    assert.equal(
      hasUndeliverableReservedDomain(domainCase.email),
      domainCase.reserved,
      domainCase.email,
    );
  }
});
