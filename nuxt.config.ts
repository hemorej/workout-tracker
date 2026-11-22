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
     * The app has no dark mode — pin color mode to light so Nuxt UI doesn't
     * follow the OS preference (adds `.dark` to <html>, flipping native controls).
     */
    colorMode: {
        preference: 'light',
        fallback: 'light',
        // New key so a stale 'dark' saved in localStorage under the default
        // key can't override the pinned preference.
        storageKey: 'sprocket-color-mode',
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
        '@sentry/nuxt/module',
    ],

    /**
     * Sentry error/performance monitoring. Runtime init lives in
     * sentry.client.config.ts / sentry.server.config.ts and is a no-op unless
     * SENTRY_DSN is set. Sourcemaps are only generated + uploaded (then deleted
     * from the output) when SENTRY_AUTH_TOKEN is present at build time.
     */
    sentry: {
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        // Without a token there is nothing to upload to: skip the plugin entirely.
        sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
        buildTimeInstrumentation: false,
    },
    // Sourcemaps (client AND server) only when uploading to Sentry. The Vite SSR build
    // otherwise emits maps for every chunk, which Nitro's rollup pass then re-reads.
    sourcemap: {
        client: process.env.SENTRY_AUTH_TOKEN ? 'hidden' : false,
        server: process.env.SENTRY_AUTH_TOKEN ? 'hidden' : false,
    },

    /**
     * `@nuxt/icon` (pulled in by `@nuxt/ui`). Default behaviour bundles the
     * *entire* installed Iconify collection (`@iconify-json/heroicons`, the
     * only one installed) into the Nitro server output
     * so the runtime `/api/_nuxt_icon` endpoint can serve any icon on demand.
     *
     * This app only ever renders ~20 distinct icons, all statically named in
     * templates (no dynamic `i-heroicons-${x}` construction anywhere). So:
     *   - `serverBundle: false` — drop the full collections from the server
     *     build entirely.
     *   - `clientBundle.scan` — walk the app source, find every `i-{prefix}-*`
     *     reference, and inline just those SVGs into the client bundle. Nuxt UI
     *     adds its own internal icons (spinners, chevrons, close buttons) via
     *     the `icon:clientBundleIcons` hook, so those are covered automatically.
     *
     * Net: no icon round-trip on first render, and the server bundle shrinks
     * by ~1.2 MB. If a dynamically-built icon name is ever added, list it
     * explicitly under `clientBundle.icons`.
     */
    icon: {
        serverBundle: false,
        clientBundle: {
            scan: true,
            sizeLimitKb: 256,
        },
    },

    /**
     * Runtime config values exposed server-side only (no `public` key = server only).
     * Values come from `process.env` when this file is evaluated (dev / build).
     * At runtime Nuxt additionally overrides any key from a `NUXT_`-prefixed
     * variable (camelCase → SCREAMING_SNAKE), so e.g. `NUXT_WAHOO_CLIENT_ID`
     * also sets `wahooClientId` — either spelling works for the Strava/Wahoo
     * credentials below. The variables that read from `process.env` here:
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
     *   NUXT_ZWIFT_SYNC_TOKEN   → runtimeConfig.zwiftSyncToken
     *   NUXT_ZWIFT_ACTIVITY_TOKEN → runtimeConfig.zwiftActivityToken
     */
    runtimeConfig: {
        // The only `public` key: the Sentry DSN is write-only by design and the
        // browser SDK needs it. Override at runtime with NUXT_PUBLIC_SENTRY_DSN.
        public: {
            sentry: { dsn: process.env.SENTRY_DSN },
        },

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

        // Shared secret authenticating POST /api/zwift/sync and
        // GET /api/zwift/sync/manifest — the local Zwift-folder sync daemon
        // (scripts/zwift-sync.ts) sends it as a Bearer token. Unset ⇒ both
        // endpoints always 401. Generate with: openssl rand -hex 32
        zwiftSyncToken: process.env.NUXT_ZWIFT_SYNC_TOKEN,

        // Shared secret authenticating POST /api/zwift/activity — the local
        // Zwift-activities daemon (scripts/zwift-activities.ts) uploads finished
        // rides with it as a Bearer token. Separate from the workout-library
        // token because this one can create workouts. Unset ⇒ always 401.
        zwiftActivityToken: process.env.NUXT_ZWIFT_ACTIVITY_TOKEN,

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
         * password is read from NUXT_SESSION_PASSWORD at runtime — nuxt-auth-utils
         * now types `session` without `password`, so it must not be declared here.
         */
        session: {
            maxAge: 60 * 60 * 24 * 30, // 30 days — override with NUXT_SESSION_MAX_AGE
            // password intentionally omitted (module reads NUXT_SESSION_PASSWORD).
            // The cast papers over conflicting type declarations: h3's SessionConfig
            // requires `password`, nuxt-auth-utils' runtime-config typing forbids it.
        } as any,
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
            /**
             * Nuxt UI's built-in components (modal close button, select
             * chevrons, toast status icons, loading spinners, …) default to
             * Lucide. Remap every default slot to its Heroicons equivalent so
             * the whole app renders a single icon set. Lucide is deliberately
             * NOT installed, so an unmapped slot would render blank — keep this
             * list in sync with Nuxt UI's default icons.
             */
            icons: {
                arrowDown: 'i-heroicons-arrow-down',
                arrowLeft: 'i-heroicons-arrow-left',
                arrowRight: 'i-heroicons-arrow-right',
                arrowUp: 'i-heroicons-arrow-up',
                caution: 'i-heroicons-exclamation-circle',
                check: 'i-heroicons-check',
                chevronDoubleLeft: 'i-heroicons-chevron-double-left',
                chevronDoubleRight: 'i-heroicons-chevron-double-right',
                chevronDown: 'i-heroicons-chevron-down',
                chevronLeft: 'i-heroicons-chevron-left',
                chevronRight: 'i-heroicons-chevron-right',
                chevronUp: 'i-heroicons-chevron-up',
                close: 'i-heroicons-x-mark',
                copy: 'i-heroicons-document-duplicate',
                copyCheck: 'i-heroicons-clipboard-document-check',
                dark: 'i-heroicons-moon',
                drag: 'i-heroicons-bars-3',
                ellipsis: 'i-heroicons-ellipsis-horizontal',
                error: 'i-heroicons-x-circle',
                external: 'i-heroicons-arrow-up-right',
                eye: 'i-heroicons-eye',
                eyeOff: 'i-heroicons-eye-slash',
                file: 'i-heroicons-document',
                folder: 'i-heroicons-folder',
                folderOpen: 'i-heroicons-folder-open',
                hash: 'i-heroicons-hashtag',
                info: 'i-heroicons-information-circle',
                light: 'i-heroicons-sun',
                loading: 'i-heroicons-arrow-path',
                menu: 'i-heroicons-bars-3',
                minus: 'i-heroicons-minus',
                panelClose: 'i-heroicons-chevron-double-left',
                panelOpen: 'i-heroicons-chevron-double-right',
                plus: 'i-heroicons-plus',
                reload: 'i-heroicons-arrow-path',
                search: 'i-heroicons-magnifying-glass',
                stop: 'i-heroicons-stop',
                star: 'i-heroicons-star',
                success: 'i-heroicons-check-circle',
                system: 'i-heroicons-computer-desktop',
                tip: 'i-heroicons-light-bulb',
                upload: 'i-heroicons-arrow-up-tray',
                warning: 'i-heroicons-exclamation-triangle',
            },
        },
    },

    /**
     * `@nuxt/fonts` (auto-installed by `@nuxt/ui`) would otherwise try to
     * resolve these from Google Fonts at build time. All three are vendored
     * instead via `@fontsource(-variable)/*` + a manual `@font-face` in
     * main.css, so tell the module to leave them alone — it still handles
     * fallback-metric generation etc. for anything else that needs it.
     * Archivo + Instrument Serif are used only by the photo overlay poster
     * (app/pages/overlay/[activityId].vue), drawn to <canvas>.
     */
    fonts: {
        families: [
            { name: 'Hanken Grotesk', provider: 'none' },
            { name: 'Archivo', provider: 'none' },
            { name: 'Instrument Serif', provider: 'none' },
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

    devtools: { enabled: false },

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
            // nginx has no ngx_brotli (brotli_static is commented out in infra/nginx.conf),
            // so .br files would never be served; skip the slow compression pass.
            brotli: false,
        },
        // Keep the pg chain bundled. @sentry/nuxt externalizes instrumented
        // packages; left external, postgres-interval's extensionless
        // `xtend/mutable` import fails under Node ESM and every request 500s.
        // Nitro's esbuild pass defaults to es2019, which warns "Big integer literals are
        // not available" for tailwind-variants' `0n` (via Nuxt UI) on every deploy build.
        // The server runs on Node 26 (see `engines`), so a modern target is safe.
        esbuild: { options: { target: 'es2022' } },
        // Server sourcemaps are only needed in production when uploading to Sentry
        // (SENTRY_AUTH_TOKEN set); otherwise skip the transform/write cost.
        // Kept on locally in case you want to debug a build.
        sourceMap: process.env.NODE_ENV !== 'production' || Boolean(process.env.SENTRY_AUTH_TOKEN),
    },

    /**
     * Route-level caching. Pages stay server-rendered (the dashboard (/) is
     * per-user and must not be cached). `/login` used to be prerendered, but that
     * cost ~1 min per deploy (a throwaway Nitro bundle + Sentry upload) to save
     * milliseconds on a single-user app's login page.
     *
     * The icon files under `public/` have no content hash in their filename
     * (unlike `_nuxt/` assets), so unlike the self-hosted fonts they don't
     * get Nitro's automatic long-lived cache headers — they were serving
     * with no cache-control at all. A week is long enough to skip most
     * repeat-visit requests but short enough that a real icon change won't
     * stick around for a year like `immutable` would.
     */
    routeRules: {
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
