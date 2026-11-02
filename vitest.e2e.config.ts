import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'agent-bundle-core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/tests/e2e/**/*.e2e.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
