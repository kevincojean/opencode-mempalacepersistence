import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["e2e/**/*.spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Run tests serially since each creates its own env
    pool: "forks",
    poolOptions: {
      forks: {
        singleTest: true,
        singleFork: true,
      },
    },
  },
})
