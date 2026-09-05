// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: '2026-07-29',

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
     *   WAHOO_CLIENT_ID         → runtimeConfig.wahooClientId
     *   WAHOO_CLIENT_SECRET     → runtimeConfig.wahooClientSecret
     *   WAHOO_REFRESH_TOKEN     → runtimeConfig.wahooRefreshToken
     *   NUXT_WAHOO_WEBHOOK_TOKEN → runtimeConfig.wahooWebhookToken
     *   NUXT_FIT_STORAGE_DIR    → runtimeConfig.fitStorageDir
     *   NUXT_WEBHOOK_USER_EMAIL → runtimeConfig.webhookUserEmail
     *   ANTHROPIC_API_KEY       → runtimeConfig.anthropicApiKey
     *   NUXT_SEGMENTS_SYNC_TOKEN → runtimeConfig.segmentsSyncToken
     */
    runtimeConfig: {
        databaseUrl: process.env.DATABASE_URL,

        // Anthropic API access — AI coach workout generation. Static key,
        // no rotation flow (unlike Strava/Wahoo).
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,

        // Strava API access — single-user, refresh token acquired via a one-time
        // manual OAuth exchange (see CLAUDE.md). No in-app OAuth flow. Drives
        // the completed-workout picker's activity list and the tracked-segments
        // feature (History → Segments).
        stravaClientId: process.env.STRAVA_CLIENT_ID,
        stravaClientSecret: process.env.STRAVA_CLIENT_SECRET,
        stravaRefreshToken: process.env.STRAVA_REFRESH_TOKEN,

        // Shared secret authenticating POST /api/segments/reconcile, the
        // nightly tracked-segments safety net (hit by a Forge scheduled job).
        // Generate with: openssl rand -hex 32
        segmentsSyncToken: process.env.NUXT_SEGMENTS_SYNC_TOKEN,

        // Wahoo Cloud API access — single-user, refresh token acquired via a
        // one-time manual OAuth exchange (see CLAUDE.md). No in-app OAuth flow.
        wahooClientId: process.env.WAHOO_CLIENT_ID,
        wahooClientSecret: process.env.WAHOO_CLIENT_SECRET,
        wahooRefreshToken: process.env.WAHOO_REFRESH_TOKEN,

        // Shared secret authenticating the public Wahoo webhook endpoint
        // (server/api/wahoo/webhook.post.ts). Must equal the `webhook_token`
        // configured on the Wahoo webhook subscription.
        wahooWebhookToken: process.env.NUXT_WAHOO_WEBHOOK_TOKEN,

        // Directory where the webhook persists raw Wahoo FIT files. Relative
        // paths resolve against the process cwd; defaults to a gitignored dev
        // dir. In production set an absolute path OUTSIDE the Forge release
        // dir so the files survive deploys and accumulate over time.
        fitStorageDir: process.env.NUXT_FIT_STORAGE_DIR || '.data/fit-files',

        // Optional — pins the webhook's target user by email. When unset the
        // webhook resolves the sole `users` row (single-user app).
        webhookUserEmail: process.env.NUXT_WEBHOOK_USER_EMAIL,

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
     * Nuxt UI theme configuration.
     *
     * Sets the primary colour to 'orange' (Sprocket's energetic accent) and
     * the neutral palette to 'stone' (warm grays rather than cool
     * blue-grays). Primary drives all UButton fills, focus rings and
     * interactive accents.
     *
     * Deliberately set here rather than in a standalone `app.config.ts` —
     * with `future.compatibilityVersion: 4` (srcDir moved to `app/`), Nuxt
     * 4.5.2's Nitro "impound" plugin throws on `#build/app.config.mjs`
     * whenever `app.config.ts` lives inside `app/` (the only place Nuxt
     * will actually pick it up in this layout; at the repo root it's
     * silently ignored). Setting `appConfig` here instead is read directly
     * into `nuxt.options.appConfig` at module-setup time, before `@nuxt/ui`
     * merges in its own (green) defaults, so it always wins without going
     * through that broken file-resolution path.
     */
    appConfig: {
        ui: {
            colors: {
                primary: 'orange',
                neutral: 'stone',
            },
        },
    },

    /**
     * `@nuxt/fonts` (auto-installed by `@nuxt/ui`) would otherwise try to
     * resolve 'Hanken Grotesk' from Google Fonts at build time. It's vendored
     * instead via `@fontsource-variable/hanken-grotesk` + a manual `@font-face`
     * in main.css, so tell the module to leave that family alone — it still
     * handles fallback-metric generation etc. for anything else that needs it.
     */
    fonts: {
        families: [
            { name: 'Hanken Grotesk', provider: 'none' },
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

    css: ['~/assets/css/main.css'],

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
        // No Sentry or other sourcemap consumer wired up — skip the transform/write
        // cost in production. Kept on locally in case you want to debug a build.
        sourceMap: process.env.NODE_ENV !== 'production',
    },

    /**
     * Route-level caching. The login page has no per-user data, so it can
     * be prerendered to a static file at build time. Everything else stays
     * dynamic — the dashboard (/) is per-user and must not be cached.
     *
     * The icon files under `public/` have no content hash in their filename
     * (unlike `_nuxt/` assets), so unlike the self-hosted fonts they don't
     * get Nitro's automatic long-lived cache headers — they were serving
     * with no cache-control at all. A week is long enough to skip most
     * repeat-visit requests but short enough that a real icon change won't
     * stick around for a year like `immutable` would.
     */
    routeRules: {
        '/login': { prerender: true },
        '/favicon.svg': { headers: { 'cache-control': 'public, max-age=604800' } },
        '/apple-touch-icon.png': { headers: { 'cache-control': 'public, max-age=604800' } },
        '/site.webmanifest': { headers: { 'cache-control': 'public, max-age=604800' } },
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
                    // Object form only ever worked under Rollup; the Vite/Nitro
                    // bump switched the build to rolldown, whose manualChunks
                    // only accepts a function.
                    manualChunks(id) {
                        if (!id.includes('node_modules')) return
                        if (id.includes('node_modules/vue/') || id.includes('node_modules/vue-router/')) return 'vue'
                        if (id.includes('node_modules/pinia/')) return 'pinia'
                    },
                },
            },
            // Raise the warning threshold since @nuxt/ui's chunk is legitimately large.
            chunkSizeWarningLimit: 1000,
        },
    },
})
