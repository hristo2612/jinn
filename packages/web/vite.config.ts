import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

/**
 * The UI face is only discoverable once the stylesheet has downloaded and
 * parsed, which puts the one font every screen draws a full round trip behind
 * the HTML. Only the latin variable file is preloaded: latin-ext and the mono
 * weights are conditional on what a page actually renders, and preloading a
 * font that never gets drawn is a wasted request.
 */
function preloadUiFont(): Plugin {
  const uiFont = /^assets\/hanken-grotesk-latin-var-[^/]+\.woff2$/
  return {
    name: 'jinn-preload-ui-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const emitted = Object.keys(ctx.bundle ?? {}).find((name) => uiFont.test(name))
        if (!emitted) {
          throw new Error(
            'jinn-preload-ui-font: no hanken-grotesk-latin-var woff2 in the bundle. ' +
              'If the file was renamed, update the pattern; if the face was dropped, drop this plugin.',
          )
        }
        return {
          html,
          tags: [
            {
              tag: 'link',
              // Fonts are fetched in CORS mode even same-origin; without
              // crossorigin the preload misses and the browser fetches twice.
              attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: `/${emitted}` },
              injectTo: 'head-prepend',
            },
          ],
        }
      },
    },
  }
}

export default defineConfig(() => {
  const gatewayPort = process.env.GATEWAY_PORT ?? '7777'
  return {
    plugins: [
      react(),
      preloadUiFont(),
      VitePWA({
        // Registered from main.tsx instead, so the one call site is greppable.
        injectRegister: null,
        // public/manifest.webmanifest is hand-written and already linked from
        // index.html; a generated second manifest would just contradict it.
        manifest: false,
        workbox: {
          // Named rather than **/*.js on purpose: out/assets holds ~350 files,
          // most of them per-language Prism chunks behind a lazy route. The
          // shell is the entry, the vendor chunks, the entry CSS, the fonts and
          // the icons — precaching the rest would cost megabytes nobody reads.
          globPatterns: [
            'manifest.webmanifest',
            'apple-touch-icon.png',
            'icons/*.png',
            'assets/index-*.js',
            'assets/vendor-*.js',
            'assets/index-*.css',
            'assets/*.woff2',
          ],
          // A superseded hashed chunk the user cannot clear is a permanent bug,
          // so old precaches are dropped rather than left to age out.
          cleanupOutdatedCaches: true,
          // vite-plugin-pwa defaults this to 'index.html', which registers a
          // precache-first NavigationRoute ahead of everything below. The
          // navigation rule in runtimeCaching replaces it, and sw-shell-warm.js
          // seeds the cache that rule falls back to.
          navigateFallback: undefined,
          importScripts: ['/sw-shell-warm.js'],
          runtimeCaching: [
            // Todos, sessions and the roster are a live ledger. A cached
            // snapshot rendered without a staleness marker is worse than an
            // honest "gateway unreachable", so /api never enters a cache.
            // Stated explicitly so a future default cannot quietly start
            // caching it.
            {
              urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/'),
              handler: 'NetworkOnly',
            },
            // The document, and only the document, is fetched fresh. Serving it
            // from the precache instead (workbox's navigateFallback) would mean
            // a deploy needs two reloads to take effect: the first still boots
            // the old index and only then installs the new worker. The chunks,
            // CSS and fonts it references still come from the precache, so this
            // costs one small round trip and keeps the paint instant.
            //
            // The cache key is pinned rather than left per-URL: every client
            // route resolves to the same index, and a per-URL cache would make
            // /todos offline depend on having visited /todos while online.
            {
              urlPattern: ({ request, url }: { request: Request; url: URL }) =>
                request.mode === 'navigate' && !url.pathname.startsWith('/api/'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'jinn-app-shell',
                networkTimeoutSeconds: 3,
                plugins: [{ cacheKeyWillBeUsed: async () => '/index.html' }],
              },
            },
          ],
          skipWaiting: true,
          clientsClaim: true,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        // The plugin SDK is a specifier, not a package: a real package would
        // need its own build and its own React peer, and the singleton the SDK
        // exists to guarantee is exactly what a second React copy would break.
        '@jinn/plugin-sdk': path.resolve(__dirname, 'src/plugins/sdk/index.ts'),
        // Types only, and only ever imported with `import type`, so this alias
        // never resolves at build time — it exists so `tsc` and Vite agree on
        // what the specifier means.
        '@jinn/workflow-wire': path.resolve(__dirname, '../jinn/src/workflows/wire.ts'),
        // Unlike the line above, this one does resolve at build time: the module
        // is runtime code the bundle really carries. It is a pure leaf with an
        // empty import list, which is what keeps that safe with no polyfills.
        '@jinn/fallback-map-wire': path.resolve(__dirname, '../jinn/src/shared/fallback-map-wire.ts'),
        // The same leaf treatment as the line above, and for the same reason: the
        // editor has to judge a model id by the rule the config loader judges it
        // by, and a second copy of that rule is a second answer waiting to drift.
        '@jinn/model-id': path.resolve(__dirname, '../jinn/src/shared/model-id.ts'),
      },
    },
    build: {
      outDir: 'out',
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.split(path.sep).join('/')
            if (!normalized.includes('/node_modules/')) return
            if (
              normalized.includes('/node_modules/react/') ||
              normalized.includes('/node_modules/react-dom/') ||
              normalized.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react'
            }
            if (
              normalized.includes('/node_modules/react-router/') ||
              normalized.includes('/node_modules/react-router-dom/')
            ) {
              return 'vendor-router'
            }
            if (
              normalized.includes('/node_modules/@tanstack/react-query/') ||
              normalized.includes('/node_modules/@tanstack/query-core/')
            ) {
              return 'vendor-query'
            }
            // Radix and cmdk deliberately get no bucket. One shared bucket is
            // all-or-nothing: a single primitive in the shell drags every
            // primitive any route uses into the first load. Left alone, Rollup
            // puts each primitive with the route that needs it.
          },
        },
      },
    },
    server: {
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${gatewayPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://127.0.0.1:${gatewayPort}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  }
})
