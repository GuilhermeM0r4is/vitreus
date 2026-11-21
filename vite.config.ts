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
    // A single modern target (Tauri ships inside its own WebView, not an
    // arbitrary browser, so there's no real cross-browser matrix to hit).
    // The previous multi-target array (es2021 + chrome100 + safari14) made
    // this esbuild/Vite combo choke specifically on destructuring syntax
    // during minification - a single target avoids that reconciliation path.
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
