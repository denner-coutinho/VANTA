import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Em desenvolvimento, /api é encaminhado para o servidor Fastify: cliente e API ficam
// na mesma origem, o que permite cookie de refresh SameSite=Strict sem CORS.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0") },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:4000", rewrite: (p: string) => p.replace(/^\/api/, "") },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: { output: { manualChunks: { three: ["three"], react: ["react", "react-dom", "react-router-dom"] } } },
  },
  test: { environment: "jsdom" },
} as never);
