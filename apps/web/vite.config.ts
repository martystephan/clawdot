import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Set by the Tauri CLI when running `tauri [ios|android] dev` against a
// physical device: the dev server must listen on the LAN so the phone can
// reach it. Unset in every other workflow, leaving the defaults untouched.
const tauriDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  server: {
    host: tauriDevHost ?? false,
    hmr: tauriDevHost
      ? { protocol: "ws", host: tauriDevHost, port: 1431 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
