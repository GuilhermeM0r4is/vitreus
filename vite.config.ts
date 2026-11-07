import { defineConfig } from "vite";

// Tauri expects a fixed dev server port and to ignore its own
// src-tauri directory so file watching doesn't loop on build output.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: ["es2021", "chrome100", "safari14"],
    minify: "esbuild",
    sourcemap: false,
  },
});
