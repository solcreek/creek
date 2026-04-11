import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: join(process.cwd(), "../.."),
  },
  async rewrites() {
    return [
      // Deploy-button landing URL — match Cloudflare / Vercel / Netlify
      // convention of `/deploy?url=<repo>` so template authors can drop
      // in the badge without a mental model shift. The /new page handles
      // both ?url= and ?repo= query params.
      { source: "/deploy", destination: "/new" },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
