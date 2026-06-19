import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  // svelteTesting() resolves Svelte's browser build and auto-cleans the DOM
  // after each test; jsdom gives component tests a document to render into
  // (the pure-logic tests are DOM-agnostic and run fine under it too).
  plugins: [svelte({ hot: false }), svelteTesting()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
