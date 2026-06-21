import { defineAppConfig } from "nuxt/app";

/**
 * Nuxt UI theme configuration.
 *
 * Sets the primary colour to 'sky' (a calm, airy blue) and the neutral
 * palette to 'stone' (warm grays rather than cool blue-grays).
 * This gives the whole app a light, natural feel without using
 * any harsh or saturated colours.
 */
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'sky',
      neutral: 'stone',
    },
  },
})
