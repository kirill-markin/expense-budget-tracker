import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideAdminAccess } from "./access";

const config = { adminEmails: ["admin@example.com"] };

describe("decideAdminAccess", () => {
  it("redirects to login without a verified session", () => {
    assert.equal(decideAdminAccess(null, config), "redirect_to_login");
  });

  it("allows a verified email that equals a listed email exactly", () => {
    assert.equal(decideAdminAccess({ email: "admin@example.com", email_verified: true }, config), "allowed");
  });

  it("forbids a case variant of a listed email", () => {
    assert.equal(decideAdminAccess({ email: "Admin@Example.com", email_verified: true }, config), "forbidden");
  });

  it("forbids a whitespace-padded listed email", () => {
    assert.equal(decideAdminAccess({ email: " admin@example.com ", email_verified: true }, config), "forbidden");
  });

  it("forbids a verified email that is not listed", () => {
    assert.equal(decideAdminAccess({ email: "user@example.com", email_verified: true }, config), "forbidden");
  });

  it("forbids a listed email that is not verified", () => {
    assert.equal(decideAdminAccess({ email: "admin@example.com", email_verified: false }, config), "forbidden");
  });

  it("forbids a non-boolean email_verified claim", () => {
    assert.equal(decideAdminAccess({ email: "admin@example.com", email_verified: "true" }, config), "forbidden");
  });

  it("forbids a token without an email claim", () => {
    assert.equal(decideAdminAccess({ email_verified: true }, config), "forbidden");
  });
});
