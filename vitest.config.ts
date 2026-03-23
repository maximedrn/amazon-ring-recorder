import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests sequentially within each file to avoid shared-state races.
    sequence: { concurrent: false },
    // Print a full diff on assertion failures.
    reporters: ["verbose"],
    // Coverage via v8 (no Babel transform needed).
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/types/**"],
      // Enforce minimum thresholds so coverage regressions fail CI.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    // Point at the source directly – no compile step needed.
    include: ["src/**/*.test.ts"],
  },
});
