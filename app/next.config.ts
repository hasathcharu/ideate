import type { NextConfig } from 'next'
import { execSync } from 'node:child_process'

/** Short commit hash of the current checkout, inlined into the client bundle
 *  as NEXT_PUBLIC_COMMIT_SHA (see lib/config.ts). Falls back to 'dev' when
 *  there's no git history available (e.g. a shallow deploy artifact). */
function commitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
}

const nextConfig: NextConfig = {
  experimental: {
    // Image uploads and generated PNGs cross the Server Action boundary as base64.
    // 150 MB accommodates GitHub's 100 MB file ceiling plus base64 expansion.
    serverActions: { bodySizeLimit: '150mb' },
  },
  env: {
    NEXT_PUBLIC_COMMIT_SHA: commitSha(),
  },
}

export default nextConfig
