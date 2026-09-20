import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'public/excalidraw-assets/**']),
  {
    // Existing shell/editor effects and ref handling are addressed by stages 4–5.
    // Keep the remaining Next, React, and TypeScript rules active for new work.
    rules: {
      '@next/next/no-sync-scripts': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react/no-unescaped-entities': 'warn',
      'prefer-const': 'warn',
      'react/no-danger': 'error',
    },
  },
])
