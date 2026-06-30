// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    /**
     * Nuxt 4 compatibility mode — enables the new `app/` source directory layout
     * and other forward-looking defaults.
     */
    future: {
        compatibilityVersion: 4,
    },

    /**
     * Registered modules.
     * - @nuxt/ui: component library (UButton, UModal, UTable, UForm, etc.)
     * - nuxt-auth-utils: lightweight cookie-based session management
     * - @pinia/nuxt: Pinia store integration
     */
    modules: [
        '@nuxt/ui',
        'nuxt-auth-utils',
        '@pinia/nuxt',
    ],

    /**
     * Runtime config values exposed server-side only (no `public` key = server only).
     * These are overridden by environment variables at runtime:
     *   DATABASE_URL            → runtimeConfig.databaseUrl
     *   NUXT_SESSION_PASSWORD   → read directly by nuxt-auth-utils (≥32 chars required)
     *   NUXT_SESSION_MAX_AGE    → overrides runtimeConfig.session.maxAge
     */
    runtimeConfig: {
        databaseUrl: process.env.DATABASE_URL,

        /**
         * nuxt-auth-utils session configuration.
         * maxAge controls how long the encrypted cookie lives (in seconds).
         * The encryption key comes from NUXT_SESSION_PASSWORD env var.
         */
        // session: {
        //     maxAge: 60 * 60 * 24 * 7, // 7 days — override with NUXT_SESSION_MAX_AGE
        // },
    },

    /**
     * Global CSS — base typography, font import, page transition.
     */
    app: {
        head: {
            meta: [
                { name: 'theme-color', content: '#fafaf9' },
                { name: 'apple-mobile-web-app-capable', content: 'yes' },
                { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
                { name: 'apple-mobile-web-app-title', content: 'Sprocket' },
            ],
            link: [
                { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
                { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
                { rel: 'manifest', href: '/site.webmanifest' },
            ],
        },
    },

    css: ['./app/assets/css/main.css'],

    devtools: {enabled: true},

    /**
     * TypeScript strict mode — catches more bugs at compile time.
     */
    typescript: {
        strict: true,
    },

    /**
     * Pre-compress public assets (gzip + brotli) at build time so the
     * production server can serve the compressed variant directly instead
     * of compressing on every request.
     */
    nitro: {
        compressPublicAssets: {
            gzip: true,
            brotli: true,
        },
    },

    /**
     * Route-level caching. The login page has no per-user data, so it can
     * be prerendered to a static file at build time. Everything else stays
     * dynamic — the dashboard (/) is per-user and must not be cached.
     */
    routeRules: {
        '/login': { prerender: true },
    },

    vite: {
        build: {
            /**
             * Split large third-party deps into their own chunks so app code
             * changes don't bust the cache for vendor code, and the initial
             * JS payload can be fetched in parallel.
             */
            rollupOptions: {
                output: {
                    manualChunks: {
                        vue: ['vue', 'vue-router'],
                        pinia: ['pinia'],
                    },
                },
            },
            // Raise the warning threshold since @nuxt/ui's chunk is legitimately large.
            chunkSizeWarningLimit: 1000,
        },
    },
})
