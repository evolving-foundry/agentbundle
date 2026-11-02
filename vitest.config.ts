import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'agent-bundle-core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
