import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    target: "es2022",
    // The island, its settings window, the shortcut popup and the capture overlay; preview.html is dev-only.
    rollupOptions: { input: { island: "index.html", settings: "settings.html", popup: "popup.html", overlay: "overlay.html" } },
  },
});
