/**
 * robots.txt for the auth subdomain.
 *
 * Signals compliant crawlers not to crawl any auth pages or endpoints.
 * This is advisory only and does not block malicious scrapers.
 */
import { Hono } from "hono";

const app = new Hono();

const ROBOTS_TXT = "User-agent: *\nDisallow: /";

app.get("/robots.txt", (c) => c.text(ROBOTS_TXT));

export default app;
