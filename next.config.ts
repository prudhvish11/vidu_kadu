import type { NextConfig } from "next";

// Static export for GitHub Pages (no Node server). All data flows through the
// client-side Supabase client, and room codes live in the query string, so
// every route can be a static SPA shell.
//
// For a project site (username.github.io/<repo>), set NEXT_PUBLIC_BASE_PATH to
// "/<repo>" at build time so assets and links resolve under the subpath. Leave
// it unset for a user/custom-domain site served from the root.
// A lone "/" (what configure-pages emits for user/apex sites) is not a valid
// Next.js basePath, so normalize it and any trailing slash away to "".
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const basePath = rawBasePath === "/" ? "" : rawBasePath.replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  basePath: basePath || undefined,
};

export default nextConfig;
