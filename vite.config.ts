import { defineConfig } from 'vite';

/**
 * Vite configuration for Nashik Monitor.
 *
 * In development, /api/assist is proxied to the locally running SevaSetu API
 * server (default: http://localhost:3001). This means:
 *   - No CORS issues during local development
 *   - VITE_SEVASETU_API_URL can be left empty in .env.local
 *   - The proxy is only active during `npm run dev`; the production build
 *     uses VITE_SEVASETU_API_URL directly as the API base URL
 *
 * All other Vite behaviour (entry point, build output, TypeScript handling)
 * is unchanged from Vite's zero-config defaults.
 */
export default defineConfig(() => {
  // Local SevaSetu API server — used only by the dev proxy.
  // VITE_SEVASETU_API_URL is for production; in dev the proxy handles routing.
  const devApiTarget = 'http://localhost:3001';

  return {
    server: {
      proxy: {
        // Forward /api/assist to the local SevaSetu API server during development.
        // In production, VITE_SEVASETU_API_URL in client.ts points to the live API.
        '/api/assist': {
          target: devApiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
