import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const LOCAL_ADMIN_ENV: Readonly<Record<string, string>> = {
  ADMIN_AUTH_MODE: "none",
  ADMIN_ORIGIN: "http://localhost:3001",
  ADMIN_EMAILS: "admin@example.com",
  ANALYTICS_EXCLUDED_EMAILS: "",
  DATABASE_URL: "postgresql://unused@localhost:5432/unused",
};

const cspDirective = (csp: string, name: string): string => {
  const directive = csp.split(";").map((part: string): string => part.trim()).find(
    (part: string): boolean => part.startsWith(`${name} `),
  );
  if (directive === undefined) {
    throw new Error(`CSP has no ${name} directive: ${csp}`);
  }
  return directive;
};

test("CSP lets the GET filter forms submit to the admin origin", async () => {
  Object.assign(process.env, LOCAL_ADMIN_ENV);
  const response = await proxy(new NextRequest("http://localhost:3001/analytics/level-1-metrics", {
    headers: { host: "localhost:3001" },
  }));

  const csp = response.headers.get("Content-Security-Policy");
  assert.notEqual(csp, null);
  assert.equal(cspDirective(csp ?? "", "form-action"), "form-action 'self'");
});
