import { defineConfig } from "vite";

// Tauri expects a fixed dev port and must not clear its own terminal output.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // Assets load from local disk, not the network; the main chunk is mostly xterm, needed at startup.
  build: { target: "es2022", chunkSizeWarningLimit: 800 },
});
