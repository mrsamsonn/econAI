import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const proxyTarget = (
    process.env.VITE_API_BASE ||
    fileEnv.VITE_API_BASE ||
    "http://127.0.0.1:8000"
  ).replace(/\/$/, "");

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
