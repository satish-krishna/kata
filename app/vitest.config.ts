import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // svelteTesting() resolves Svelte's browser build and auto-cleans the DOM
  // after each test; jsdom gives component tests a document to render into
  // (the pure-logic tests are DOM-agnostic and run fine under it too).
  plugins: [svelte({ hot: false }), svelteTesting()],
  // Resolve SvelteKit's $lib alias so components that import it can be rendered
  // (the vite-plugin-svelte plugin alone doesn't wire SvelteKit's aliases).
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
