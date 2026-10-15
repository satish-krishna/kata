import { defineConfig } from 'vitest/config';

// The harness has its own test target, separate from the Angular app's
// `@angular/build:unit-test` (which only sees src/**/*.spec.ts). These tests
// prove the measurement machinery: the structural counter and the gate rules.
export default defineConfig({
  test: {
    include: ['harness/**/*.test.mjs'],
    environment: 'node',
    globals: false,
  },
});
