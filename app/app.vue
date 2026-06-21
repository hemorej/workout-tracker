<template>
  <!--
    Root application shell.
    NuxtPage renders the active route's page component.
    UApp is the Nuxt UI root wrapper that provides toast/modal context.
  -->
  <UApp>
    <NuxtPage />
  </UApp>
</template>

<style>
/*
 * Global base styles — unscoped so they apply to the whole document.
 *
 * Putting these here (rather than relying solely on assets/css/main.css)
 * guarantees they are always bundled, regardless of how the `css` array
 * in nuxt.config.ts resolves paths.
 */

html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background-color: #fafaf9; /* warm off-white */
  color: #1c1917;            /* stone-900 */
}

/* Tabular figures for metric numbers — prevents layout shift as values update */
.tabular {
  font-variant-numeric: tabular-nums;
}

/* Hairline border utility */
.border-hairline {
  border: 1px solid #e7e5e4;
}

/* Page transition */
.page-enter-active,
.page-leave-active {
  transition: opacity 0.15s ease;
}
.page-enter-from,
.page-leave-to {
  opacity: 0;
}
</style>
