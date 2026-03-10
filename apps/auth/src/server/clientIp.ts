/**
 * Resolve the client IP from trusted reverse-proxy headers.
 *
 * Cloudflare sends CF-Connecting-IP. X-Forwarded-For is kept as a local-dev
 * fallback when the request does not pass through Cloudflare.
 */
import type { Context } from "hono";

const normalizeIp = (raw: string): string => raw.trim().slice(0, 128);

export const getClientIp = (context: Context): string => {
  const cloudflareIp = context.req.header("cf-connecting-ip");
  if (cloudflareIp !== undefined && cloudflareIp.trim() !== "") {
    return normalizeIp(cloudflareIp);
  }

  const forwardedFor = context.req.header("x-forwarded-for");
  if (forwardedFor !== undefined && forwardedFor.trim() !== "") {
    const firstHop = forwardedFor.split(",")[0] ?? "";
    return normalizeIp(firstHop);
  }

  const realIp = context.req.header("x-real-ip");
  if (realIp !== undefined && realIp.trim() !== "") {
    return normalizeIp(realIp);
  }

  return "unknown";
};
