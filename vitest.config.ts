import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.mjs'],
    pool: 'forks',
    maxWorkers: 1,
  },
})
