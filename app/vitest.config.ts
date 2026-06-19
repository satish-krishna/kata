import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    extensions: [".svelte.ts", ".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json", ".svelte"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
