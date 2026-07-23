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
  env: {
    NEXT_PUBLIC_COMMIT_SHA: commitSha(),
  },
}

export default nextConfig
