<script setup lang="ts">
/**
 * Training tab — the merged Training log + Planning view. Every calendar day is
 * one cell in a Monday→Sunday week row: the plan until it's ridden, then the log
 * entry. Details and actions live in one day card (hover card on desktop,
 * bottom sheet below `sm`) that TrainingDayDetail renders.
 *
 * Owns: the metrics strip, search toolbar + results (grid / list), the week
 * grid with older-weeks loading, the hover/pin card, drag-to-swap and the note
 * dialog. Flows that live on the page (add/edit ride, FIT upload, picker, coach
 * builder) are emitted as `DayAction`s.
 */
import type { TrainingDay } from '#shared/types/training'
import { useTrainingStore } from '~/stores/training'
import { useTrainingSearchStore } from '~/stores/trainingSearch'

defineProps<{ refreshingRideId: number | null }>()

const emit = defineEmits<{ action: [PageAction], openHistory: [], openEvents: [] }>()

const training = useTrainingStore()
const search = useTrainingSearchStore()
const route = useRoute()
const router = useRouter()
const toast = useToast()

// ── Search state ⇄ URL ───────────────────────────────────────────────────────

search.hydrate(route.query)
watch(() => search.urlQuery, query => router.replace({ query }))

const searching = computed(() => search.isActive)

// A search written to the URL before hydration has no results yet (state came with the SSR payload).
onMounted(() => {
  if (search.isActive && !search.results) search.runSoon()
})

// Writes (ride saved, plan edited…) change what a search would return.
watch(() => training.revision, () => searching.value && search.runSoon())

// ── Days shown ───────────────────────────────────────────────────────────────

const sourceDays = computed(() => (searching.value ? (search.results?.days ?? []) : training.days))
const weeks = computed(() => groupWeeks(sourceDays.value))
const dayByDate = computed(() => new Map(sourceDays.value.map(d => [d.date, d])))
const matchSet = computed(() => (searching.value && search.results ? new Set(search.results.matches) : null))

type Row = { kind: 'week', week: TrainingWeek } | { kind: 'gap', key: string, weeks: number, monday: string }

/** In a search only weeks with matches are loaded; runs of skipped weeks fold into one line. */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let previous: string | null = null
  for (const week of weeks.value) {
    if (searching.value && previous) {
      const skipped = Math.round((Date.parse(week.monday) - Date.parse(previous)) / (7 * 86_400_000)) - 1
      if (skipped > 0) out.push({ kind: 'gap', key: `gap-${previous}`, weeks: skipped, monday: addDaysIso(previous, 7) })
    }
    out.push({ kind: 'week', week })
    previous = week.monday
  }
  return out
})

const listDays = computed(() => (search.results?.matches ?? []).map(d => dayByDate.value.get(d)!).filter(Boolean).reverse())
const matchedWeeks = computed(() => new Set((search.results?.matches ?? []).map(mondayOf)).size)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ── Suggest-plan preview ─────────────────────────────────────────────────────

const previewing = computed(() => training.suggestPhase === 'generating' || training.suggestPhase === 'preview')
/** Projection with the draft applied; null when nothing is previewed (each day's own metrics apply). */
const draftProjection = computed(() => (training.draft ? training.project(training.draft) : null))
const metricsFor = (day: TrainingDay) => draftProjection.value?.[day.date] ?? day.metrics
const suggestLabel = (monday: string) => training.suggestWeeks.find(w => w.monday === monday)?.label ?? null

// Leaving the tab with an unapplied preview discards it — nothing was saved.
onBeforeUnmount(() => training.discardDraft())

const strip = computed(() => weekTotals(training.currentWeek))

// ── Day card: hover (desktop) / pin / sheet (touch) ──────────────────────────

const HOVER_OPEN_MS = 150
const HOVER_CLOSE_MS = 120

const isMobile = ref(false)
onMounted(() => {
  const query = window.matchMedia('(max-width: 639px)')
  isMobile.value = query.matches
  const update = (e: MediaQueryListEvent) => { isMobile.value = e.matches; closeCard() }
  query.addEventListener('change', update)
  onBeforeUnmount(() => query.removeEventListener('change', update))
})

const openDate = ref<string | null>(null)
const pinned = ref(false)
const anchor = shallowRef<HTMLElement | null>(null)
let openTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined

const cardDay = computed(() => (openDate.value ? dayByDate.value.get(openDate.value) ?? null : null))
const sheetOpen = computed({
  get: () => isMobile.value && !!openDate.value,
  set: (open) => { if (!open) closeCard() },
})
const popoverOpen = computed(() => !isMobile.value && !!cardDay.value)

/** Fri–Sun cards align to the cell's right edge so they don't run off the grid. */
const cardContent = computed(() => ({
  side: 'bottom' as const,
  align: ['5', '6', '0'].includes(String(new Date(`${openDate.value}T00:00:00Z`).getUTCDay())) ? 'end' as const : 'start' as const,
  sideOffset: 6,
  collisionPadding: 12,
  // A hover-opened card must not steal focus; a pinned one is meant to be used.
  onOpenAutoFocus: (e: Event) => { if (!pinned.value) e.preventDefault() },
  onCloseAutoFocus: (e: Event) => e.preventDefault(),
}))

const cellOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('[data-date]')

function closeCard() {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  openDate.value = null
  pinned.value = false
  anchor.value = null
}

function keepOpen() {
  clearTimeout(closeTimer)
}

function scheduleClose() {
  if (pinned.value) return
  clearTimeout(closeTimer)
  closeTimer = setTimeout(closeCard, HOVER_CLOSE_MS)
}

function onPointerOver(e: PointerEvent) {
  if (e.pointerType !== 'mouse' || pinned.value || dragDate.value) return
  const cell = cellOf(e)
  if (!cell) return
  keepOpen()
  if (cell.dataset.date === openDate.value) return
  clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    anchor.value = cell
    openDate.value = cell.dataset.date!
  }, HOVER_OPEN_MS)
}

function onPointerOut(e: PointerEvent) {
  if (e.pointerType !== 'mouse' || pinned.value) return
  const cell = cellOf(e)
  if (!cell || (e.relatedTarget instanceof Node && cell.contains(e.relatedTarget))) return
  clearTimeout(openTimer)
  scheduleClose()
}

function onClick(e: MouseEvent) {
  const cell = cellOf(e)
  if (!cell) return
  const date = cell.dataset.date!
  if (!isMobile.value && pinned.value && openDate.value === date) {
    closeCard()
    return
  }
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  anchor.value = cell
  openDate.value = date
  pinned.value = true
}

// Arrow keys move focus across cells and weeks.
const gridEl = ref<HTMLElement | null>(null)
const ARROW_DAYS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

function onKeydown(e: KeyboardEvent) {
  const delta = ARROW_DAYS[e.key]
  const cell = delta ? cellOf(e) : null
  if (!delta || !cell) return
  const next = gridEl.value?.querySelector<HTMLElement>(`[data-date="${addDaysIso(cell.dataset.date!, delta)}"]`)
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

// ── Drag to swap (planned cells, desktop) ────────────────────────────────────

const dragDate = ref<string | null>(null)
const dropDate = ref<string | null>(null)

function canDropOn(date: string) {
  const target = dayByDate.value.get(date)
  return !!dragDate.value && dragDate.value !== date && !!target && !isActualDay(target)
}

function onDragStart(e: DragEvent) {
  const cell = cellOf(e)
  if (!cell?.draggable || !e.dataTransfer) return
  closeCard()
  dragDate.value = cell.dataset.date!
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', dragDate.value)
}

function onDragOver(e: DragEvent) {
  const cell = cellOf(e)
  if (!cell || !canDropOn(cell.dataset.date!)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropDate.value = cell.dataset.date!
}

function endDrag() {
  dragDate.value = null
  dropDate.value = null
}

async function onDrop(e: DragEvent) {
  const cell = cellOf(e)
  const from = dragDate.value
  const to = cell?.dataset.date
  const allowed = !!to && canDropOn(to)
  endDrag()
  if (!from || !to || !allowed) return
  e.preventDefault()
  await swapPlans(from, to)
}

async function swapPlans(from: string, to: string) {
  try {
    await training.swapPlans(from, to)
  }
  catch {
    toast.add({ title: 'Could not move the workout', color: 'error' })
    await training.refreshFrom(from < to ? from : to)
  }
}

// ── Older weeks ──────────────────────────────────────────────────────────────

const sentinel = ref<HTMLElement | null>(null)

/** Prepends older weeks, then restores the scroll offset so the view doesn't jump. */
async function loadOlder() {
  const before = document.documentElement.scrollHeight
  if (!(await training.loadOlder())) return
  await nextTick()
  window.scrollBy(0, document.documentElement.scrollHeight - before)
}

onMounted(() => {
  const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) loadOlder() })
  onBeforeUnmount(() => observer.disconnect())

  // Current week just under the sticky header (the page publishes its height after children mount).
  // Older weeks are only observed afterwards, so the initial position doesn't trigger a load.
  requestAnimationFrame(() => {
    const week = searching.value ? null : gridEl.value?.querySelector<HTMLElement>(`[data-week="${training.currentMonday}"]`)
    const sticky = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-sticky-h')) || 0
    if (week) window.scrollTo({ top: week.getBoundingClientRect().top + window.scrollY - sticky - 44 })

    watch(sentinel, (el, old) => {
      if (old) observer.unobserve(old)
      if (el) observer.observe(el)
    }, { immediate: true })
  })
})

// ── Actions from the card ────────────────────────────────────────────────────

const note = ref<{ date: string, initial: string } | null>(null)
const fuellingDate = ref<string | null>(null)

function openNote(date: string, initial?: string) {
  note.value = { date, initial: initial ?? dayByDate.value.get(date)?.plan?.notes ?? '' }
}

async function saveNote(notes: string | null) {
  const { date } = note.value!
  note.value = null
  const plan = dayByDate.value.get(date)?.plan
  try {
    await training.savePlan(date, { name: null, type: null, tss: null, durationMinutes: null, ...plan, notes })
  }
  catch {
    toast.add({ title: 'Could not save the note', color: 'error' })
  }
}

/** Generates a fuelling guide and opens it in the note dialog to review and save — nothing persists until then. */
async function buildFuelling(date: string) {
  if (fuellingDate.value) return
  fuellingDate.value = date
  try {
    const { fuellingGuide } = await $fetch<{ fuellingGuide: string }>('/api/coach/generate', {
      method: 'POST',
      query: { date, mode: 'fuelling' },
    })
    closeCard()
    openNote(date, fuellingGuide)
  }
  catch {
    toast.add({
      title: "Couldn't generate a fuelling guide",
      description: 'Make sure a training plan is set for your account, then try again.',
      color: 'error',
    })
  }
  finally {
    fuellingDate.value = null
  }
}

async function onAction(action: DayAction) {
  if (action.type === 'fuelling') return buildFuelling(action.date)
  closeCard()
  if (action.type === 'edit-note') openNote(action.date)
  else if (action.type === 'move') await swapPlans(action.date, action.to)
  else emit('action', action)
}

// ── Display bits ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const todayColumn = computed(() => training.days.findIndex(d => d.isToday) % 7)

const isEmpty = computed(() => !training.isLoading && !training.error && training.days.length === 0)
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <TrainingMetricsStrip :summary="training.summary" :totals="strip" @open-history="emit('openHistory')" @open-events="emit('openEvents')">
      <template #actions>
        <PlanSuggest />
      </template>
    </TrainingMetricsStrip>

    <TrainingToolbar @add-workout="emit('action', { type: 'add-workout', date: localDateIso() })" />

    <!-- Search summary: count, one pill per active filter, Clear all -->
    <div v-if="searching" class="flex flex-wrap items-center gap-2">
      <span class="text-[13px] font-semibold text-stone-700">
        <template v-if="search.results">
          {{ plural(search.results.matches.length, 'match') }}<template v-if="search.q.trim()"> for “{{ search.q.trim() }}”</template> in {{ plural(matchedWeeks, 'week') }}<template v-if="search.results.truncated"> (most recent)</template>
        </template>
        <template v-else>Searching…</template>
      </span>
      <button
        v-for="f in search.activeFilters"
        :key="f.key"
        type="button"
        class="inline-flex h-7 items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 pl-3 pr-2 text-[12.5px] font-semibold text-orange-800"
        :aria-label="`Remove filter: ${f.label}`"
        @click="search.clearFilter(f.key)"
      >
        {{ f.label }}<UIcon name="i-heroicons-x-mark" class="size-3.5" />
      </button>
      <button type="button" class="text-[12.5px] text-stone-500 underline hover:text-stone-800" @click="search.clearAll()">Clear all</button>
    </div>

    <div v-if="training.isLoading" class="flex justify-center py-16">
      <BikeSpinner :size="24" class="text-stone-300" />
    </div>
    <UAlert v-else-if="training.error" color="error" variant="subtle" title="Failed to load training" :description="training.error" />
    <div v-else-if="isEmpty" class="py-20 text-center">
      <p class="mb-4 text-4xl text-stone-300">○</p>
      <p class="text-sm font-medium text-stone-500">No training history yet</p>
      <p class="mt-1.5 text-xs text-stone-400">Click "Add workout" to log your first session.</p>
    </div>

    <template v-else>
      <div v-if="searching && search.error" class="py-10 text-center text-sm text-stone-500">{{ search.error }}</div>
      <div v-else-if="searching && !search.results" class="flex justify-center py-16">
        <BikeSpinner :size="24" class="text-stone-300" />
      </div>

      <!-- List view -->
      <div
        v-else-if="searching && search.view === 'list'"
        @pointerover="onPointerOver"
        @pointerout="onPointerOut"
        @click="onClick"
      >
        <TrainingSearchList :days="listDays" :query="search.q" :open-date="isMobile ? null : openDate" />
      </div>

      <!-- Grid view -->
      <div
        v-else
        ref="gridEl"
        class="rounded-xl border border-[#f0eeec] bg-white"
        :class="previewing && 'pointer-events-none select-none'"
        @pointerover="onPointerOver"
        @pointerout="onPointerOut"
        @click="onClick"
        @keydown="onKeydown"
        @dragstart="onDragStart"
        @dragover="onDragOver"
        @dragleave="dropDate = null"
        @drop="onDrop"
        @dragend="endDrag"
      >
        <!-- Sticky day header; its first cell doubles as the older-weeks fallback button -->
        <div class="sticky z-[5] grid grid-cols-7 gap-1 rounded-t-xl bg-white px-1 pb-2 pt-2.5 sm:grid-cols-[150px_repeat(7,minmax(0,1fr))] sm:gap-1.5 sm:px-2.5" style="top: var(--app-sticky-h, 0px)">
          <button
            v-if="!searching && training.hasOlder"
            type="button"
            class="col-span-7 pb-1 pl-1.5 text-left text-xs font-medium text-stone-500 hover:text-stone-800 disabled:opacity-60 sm:col-span-1 sm:pb-0"
            :disabled="training.isLoadingOlder"
            @click.stop="loadOlder"
          >
            ↑ Older weeks
          </button>
          <span v-else class="hidden sm:block" />
          <span
            v-for="(name, i) in DAY_NAMES"
            :key="name"
            class="text-center text-[10.5px] font-semibold uppercase tracking-[.08em] sm:text-left sm:text-[11px]"
            :class="i === todayColumn ? 'text-orange-700' : 'text-stone-500'"
          >
            <span class="sm:hidden">{{ name[0] }}</span><span class="hidden sm:inline">{{ name }}</span>
          </span>
        </div>

        <div v-if="!searching && training.hasOlder" ref="sentinel" class="h-px" aria-hidden="true" />

        <template v-for="row in rows" :key="row.kind === 'week' ? row.week.monday : row.key">
          <TrainingWeekRow
            v-if="row.kind === 'week'"
            class="border-t border-[#f7f5f3]"
            :week="row.week"
            :draft="training.draft"
            :tsb-by-date="draftProjection"
            :matches="matchSet"
            :query="search.q"
            :open-date="isMobile ? null : openDate"
            :drop-date="dropDate"
            :drag-date="dragDate"
            :suggest-label="suggestLabel(row.week.monday)"
            :generating="training.suggestPhase === 'generating'"
          />
          <div v-else class="mx-1 my-1 flex h-9 items-center gap-3 rounded-lg bg-stone-50 px-3 text-xs sm:mx-2.5">
            <span class="font-semibold uppercase tracking-[.08em] text-stone-500">{{ row.weeks === 1 ? formatWeekRange(row.monday) : plural(row.weeks, 'week') }}</span>
            <span class="text-stone-400">No matches</span>
          </div>
        </template>
      </div>

      <div v-if="!searching && !training.isLoading && training.days.length" class="flex justify-center">
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
          @click="training.addWeek()"
        >
          <UIcon name="i-heroicons-plus" class="size-4" />
          Add week
        </button>
      </div>
    </template>

    <p class="text-center text-xs text-stone-300">CTL = 42-day avg &nbsp;·&nbsp; ATL = 7-day avg &nbsp;·&nbsp; TSB = CTL − ATL</p>

    <!-- Day card — one instance, anchored to the hovered / pinned cell -->
    <UPopover
      :open="popoverOpen"
      :reference="anchor ?? undefined"
      :content="cardContent"
      :dismissible="true"
      :ui="{ content: 'w-[300px] rounded-2xl border border-[#f0eeec] bg-white px-[18px] py-4 shadow-[0_16px_40px_rgba(28,25,23,.18)] ring-0' }"
      @update:open="(open: boolean) => !open && closeCard()"
    >
      <template #content>
        <div @pointerenter="keepOpen" @pointerleave="scheduleClose" @focusin="pinned = true">
          <TrainingDayDetail
            v-if="cardDay"
            :key="cardDay.date"
            :day="cardDay"
            :metrics="metricsFor(cardDay)"
            :pinned="pinned"
            :fuelling-loading="fuellingDate === cardDay.date"
            :refreshing-ride-id="refreshingRideId"
            @action="onAction"
          />
        </div>
      </template>
    </UPopover>

    <!-- Day sheet (touch) -->
    <UDrawer v-model:open="sheetOpen" :ui="{ content: 'rounded-t-[22px]' }">
      <template #content>
        <div class="max-h-[85vh] overflow-y-auto px-5 pb-8 pt-3">
          <TrainingDayDetail
            v-if="cardDay"
            :key="cardDay.date"
            :day="cardDay"
            :metrics="metricsFor(cardDay)"
            touch
            :fuelling-loading="fuellingDate === cardDay.date"
            :refreshing-ride-id="refreshingRideId"
            @action="onAction"
          />
        </div>
      </template>
    </UDrawer>

    <TrainingNoteDialog
      v-if="note"
      :date="note.date"
      :initial="note.initial"
      :has-saved-note="!!dayByDate.get(note.date)?.plan?.notes"
      @save="saveNote"
      @close="note = null"
    />
  </div>
</template>
