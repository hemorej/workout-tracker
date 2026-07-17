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
     *   STRAVA_CLIENT_ID        → runtimeConfig.stravaClientId
     *   STRAVA_CLIENT_SECRET    → runtimeConfig.stravaClientSecret
     *   STRAVA_REFRESH_TOKEN    → runtimeConfig.stravaRefreshToken
     */
    runtimeConfig: {
        databaseUrl: process.env.DATABASE_URL,

        // Strava API access — single-user, refresh token acquired via a one-time
        // manual OAuth exchange (see CLAUDE.md). No in-app OAuth flow.
        stravaClientId: process.env.STRAVA_CLIENT_ID,
        stravaClientSecret: process.env.STRAVA_CLIENT_SECRET,
        stravaRefreshToken: process.env.STRAVA_REFRESH_TOKEN,

        /**
         * nuxt-auth-utils session configuration.
         * maxAge controls how long the encrypted cookie lives (in seconds).
         * password is read from NUXT_SESSION_PASSWORD at runtime — declared
         * here only to satisfy h3's SessionConfig type (password is required).
         */
        session: {
            maxAge: 60 * 60 * 24 * 30, // 30 days — override with NUXT_SESSION_MAX_AGE
            password: process.env.NUXT_SESSION_PASSWORD ?? '',
        },
    },

    /**
     * `@nuxt/fonts` (auto-installed by `@nuxt/ui`) self-hosts fonts referenced
     * via `font-family` in our CSS instead of loading them from Google/Bunny/
     * Fontshare at request time — it downloads the woff2 files at build time
     * and serves them from our own origin, generating size-matched fallback
     * metrics to avoid layout shift. Pinned here to the exact weights and
     * subset the app actually uses (see `font-bold`/`font-extrabold` etc.
     * usage), rather than the module's broader auto-detected defaults.
     */
    fonts: {
        families: [
            { name: 'Hanken Grotesk', provider: 'google', weights: [400, 500, 600, 700, 800], subsets: ['latin'] },
        ],
    },

    /**
     * Global CSS — base typography, page transition. Font family is declared
     * here but self-hosted via the `fonts` config above, not a remote import.
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
