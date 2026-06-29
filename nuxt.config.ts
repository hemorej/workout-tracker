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
})
