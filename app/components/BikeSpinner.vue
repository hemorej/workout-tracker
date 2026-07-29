<script setup lang="ts">
/**
 * BikeSpinner — loading indicator using the Sprocket bike mark.
 *
 * Wheels and crank/pedals spin in place while the frame stays static.
 * Sized to match the `i-heroicons-arrow-path` spinner it replaces
 * (use the same `text-*` color class as before).
 */
withDefaults(defineProps<{ size?: number }>(), { size: 24 })
</script>

<template>
  <svg
    :width.attr="size"
    :height.attr="size * 0.66"
    viewBox="0 0 48 32"
    fill="none"
    stroke="currentColor"
    stroke-width="2.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M11 22 L21 22 L18 10 L11 22 M21 22 L30 10 L18 10 M30 10 L37 22 M18 10 L16.5 7 M13 7 L20 7 M30 10 L31.5 7 M28.5 7 L33.5 7" />

    <g class="bike-spinner-wheel">
      <circle cx="11" cy="22" r="7.5" />
      <path d="M11 14.5 V29.5 M3.5 22 H18.5 M6 16.5 L16 27.5 M16 16.5 L6 27.5" stroke-width="1.3" />
    </g>

    <g class="bike-spinner-wheel">
      <circle cx="37" cy="22" r="7.5" />
      <path d="M37 14.5 V29.5 M29.5 22 H44.5 M32 16.5 L42 27.5 M42 16.5 L32 27.5" stroke-width="1.3" />
    </g>

    <g class="bike-spinner-crank">
      <circle cx="21" cy="22" r="1.8" fill="currentColor" stroke="none" />
      <path d="M21 22 L21 17.3 M21 22 L21 26.7" stroke-width="1.6" />
    </g>
  </svg>
</template>

<style scoped>
.bike-spinner-wheel,
.bike-spinner-crank {
  transform-box: fill-box;
  transform-origin: center;
  animation: bike-spinner-rotate 0.9s linear infinite;
}

@keyframes bike-spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
