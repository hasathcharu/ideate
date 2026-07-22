import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // beautiful-mermaid is ESM and ships untranspiled `src` for some entry points;
  // let Next transpile it so it bundles cleanly for the client editor/preview.
  transpilePackages: ['beautiful-mermaid'],
}

export default nextConfig
