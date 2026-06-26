import { defineAppConfig } from "nuxt/app";

/**
 * Nuxt UI theme configuration.
 *
 * Sets the primary colour to 'orange' (Sprocket's energetic accent) and the
 * neutral palette to 'stone' (warm grays rather than cool blue-grays).
 * Primary drives all UButton fills, focus rings and interactive accents.
 */
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'orange',
      neutral: 'stone',
    },
  },
})
