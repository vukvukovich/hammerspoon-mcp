import { defineConfig } from 'vitest/config';

// Two named projects, because package.json scripts select them explicitly:
//   npm test              -> vitest run --project unit
//   npm run test:integration -> vitest run --project integration
// The project names below must stay in sync with those flags.
//
// This uses Vitest's `projects` option rather than a vitest.workspace file.
// The workspace file was deprecated in Vitest 3.2 and removed in Vitest 4.
export default defineConfig({
  test: {
    reporters: ['default'],

    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          // Globals stay off on purpose. Every test file imports describe, it
          // and expect from 'vitest' directly, so a reader can tell where the
          // symbols come from and the strict tsconfig needs no ambient types.
          // Do not rely on globals being injected.
          globals: false,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globals: false,
          // Each of these drives a real Hammerspoon install through a real
          // subprocess, so 5s is not enough. They are local-only and never run
          // in CI, which has no Hammerspoon.
          testTimeout: 30_000,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        // Thin bin entry: parses argv and wires the server together. There is
        // no logic to unit test, and the integration suite exercises it.
        'src/main.ts',
        '**/*.d.ts',
      ],
      // Floors, not targets. Raise them as coverage climbs; never lower them to
      // make a red build green.
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
});
