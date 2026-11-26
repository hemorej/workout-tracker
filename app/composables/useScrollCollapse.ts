/**
 * Phone-only "collapsing chrome": a 0..1 value that follows scroll direction.
 *
 * Scrolling down raises it (1 = fully collapsed), scrolling up lowers it, and it
 * is forced back to 0 at the very top of the page. It is mirrored to the
 * `--collapse` CSS custom property on <html>, which the sticky bars above the
 * week row read to shrink / tuck away (see `[[tab]].vue` and `TrainingTab.vue`).
 *
 * The bars never change their layout height — they slide via transforms and
 * sticky `top` offsets — so the document length stays constant. A height-based
 * collapse would shorten the page, which clamps `scrollY` near the bottom and
 * makes the bars flicker between the two states.
 *
 * Below `sm` only (matches Tailwind's 640px breakpoint); elsewhere, or while
 * `enabled` is false, the value stays 0 and the bars render as before.
 */
/** The shared 0..1 value (read-only use: components that swap content once it is mostly collapsed). */
export const useScrollCollapseValue = () => useState<number>('scroll-collapse', () => 0)

export function useScrollCollapse(enabled: () => boolean, { range = 96 } = {}) {
  const collapse = useScrollCollapseValue()

  let phone: MediaQueryList | undefined
  let lastY = 0
  let frame = 0
  let tween = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  const active = () => !!phone?.matches && enabled()

  function set(value: number) {
    collapse.value = value
    document.documentElement.style.setProperty('--collapse', value.toFixed(3))
  }

  /** Eases to `to` over ~160ms (instantly with reduced motion). */
  function animateTo(to: number) {
    const from = collapse.value
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return set(to)
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 160)
      set(from + (to - from) * (1 - (1 - t) ** 3))
      if (t < 1) tween = requestAnimationFrame(step)
    }
    tween = requestAnimationFrame(step)
  }

  /** Scrolling stopped mid-way: settle on whichever end is closer. */
  function settle() {
    if (collapse.value > 0 && collapse.value < 1) animateTo(collapse.value >= 0.5 ? 1 : 0)
  }

  function onScroll() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      // Clamp to the real scroll range so iOS rubber-banding isn't read as a direction change.
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      const y = Math.min(Math.max(window.scrollY, 0), max)
      const dy = y - lastY
      lastY = y
      if (!active()) return
      cancelAnimationFrame(tween)
      set(y <= 0 ? 0 : Math.min(1, Math.max(0, collapse.value + dy / range)))
      clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, 140)
    })
  }

  /** Back to fully expanded when the layout stops being a phone or the feature is turned off. */
  function reset() {
    if (active()) return
    cancelAnimationFrame(tween)
    set(0)
  }

  onMounted(() => {
    phone = window.matchMedia('(max-width: 639px)')
    lastY = window.scrollY
    window.addEventListener('scroll', onScroll, { passive: true })
    phone.addEventListener('change', reset)
  })

  watch(enabled, reset)

  onBeforeUnmount(() => {
    window.removeEventListener('scroll', onScroll)
    phone?.removeEventListener('change', reset)
    cancelAnimationFrame(frame)
    cancelAnimationFrame(tween)
    clearTimeout(settleTimer)
    document.documentElement.style.removeProperty('--collapse')
  })

  return { collapse }
}
