import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites from /<repo>/. The deploy workflow sets
// VITE_BASE=/<repo>/; dev and local preview default to '/'. Because Pages has
// no SPA rewrite, the app uses hash-based routing (see src/main.tsx).
const base = process.env.VITE_BASE ?? '/';

// App build version embedded for the update-prompt beacon (beta plan §3.1).
const appVersion = process.env.npm_package_version ?? '0.0.0';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null, // registration handled explicitly in src/pwa.ts
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Card imagery is hotlinked from Scryfall's CDN; cache it bounded &
        // cache-first so the collection stays browsable offline (beta plan §3).
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.hostname.endsWith('scryfall.io') || url.hostname.endsWith('scryfall.com'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-images',
              expiration: {
                maxEntries: 3000,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'MTG Collection & Trade',
        short_name: 'MTG Trade',
        description: 'Track your Magic: The Gathering collection and trade in person — local-first.',
        theme_color: '#1a1a1e',
        background_color: '#1a1a1e',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
});
