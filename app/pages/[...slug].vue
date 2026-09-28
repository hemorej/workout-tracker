<script setup lang="ts">
/**
 * Catch-all 404 page.
 *
 * Matches any path that doesn't hit a defined route (e.g. bot probes like
 * `/feed/`, `/wp-json/`). Having a real route match here — rather than no
 * match at all — is what stops Vue Router's "Location ... resolved to ..."
 * console warning for these paths, on top of giving them a proper 404.
 */
useHead({ title: 'Page Not Found' })
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center gap-5 bg-[#fafaf9] px-6 text-center">
    <div class="flex h-14 w-14 items-center justify-center rounded-xl bg-orange-600/[0.1]">
      <BikeLogo :size="27" class="text-orange-600 [stroke-width:2.8]" />
    </div>

    <div class="space-y-1.5">
      <h1 class="text-[22px] font-extrabold tracking-[-0.02em] text-stone-900">Page not found</h1>
      <p class="text-[15px] font-normal text-stone-500">The page you're looking for doesn't exist.</p>
    </div>

    <UButton
      to="/"
      color="neutral"
      class="rounded-full bg-orange-600 px-6 py-3 text-[15px] font-bold text-white hover:bg-orange-600"
    >
      Back to Sprocket
    </UButton>
  </div>
</template>
