import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: join(process.cwd(), "../.."),
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
