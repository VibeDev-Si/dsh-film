import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The integration test boots the real ToonFlow server from FILM_TEST_SOURCE and is skipped without it.
    include: ['tests/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
