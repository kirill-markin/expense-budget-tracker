import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Default is 10 MB. The /api/chat route sends base64-encoded images in the
    // JSON body — 5 screenshots easily exceed 10 MB. Set to 100 MB to match
    // the upstream Cloudflare free-plan limit.
    proxyClientMaxBodySize: "100mb",
    // `src/server/chat/sandbox/invoke.ts` imports `apps/sandbox/src/contract`
    // by relative path, which is outside this app's root. That file is the
    // single definition of the request and response shapes the web app and the
    // chat sandbox Lambda must agree on: the web task mints the pre-signed URLs
    // and bounds the file set, the Lambda validates both against the same
    // predicates, and a disagreement there produces a chat whose next command
    // is refused before it runs. Mirroring the contract instead is exactly what
    // a shared definition exists to avoid.
    //
    // Only `next build` needs telling: `tsc --noEmit` has no app-root boundary
    // and pulls the file into its program regardless, which is why this was
    // green in CI and red in the deploy.
    //
    // Temporary. The right home for that contract is
    // `packages/agent-shared`, which the web app already depends on as a built
    // package and which needs no boundary flag at all; that move is queued as
    // its own item rather than done under a red pipeline, and this flag goes
    // away with it.
    externalDir: true,
  },
};

export default nextConfig;
