<script setup lang="ts">
/**
 * "Suggest plan" — generates 1–4 weeks of planned workouts, previews them as a
 * draft overlay in the Planning grid (state lives in the planning store so the
 * grid can render it), and applies them on approval with an overwrite prompt
 * and Undo. Flow: idle → config → generating → preview → (confirm) → idle.
 */
import { usePlanningStore } from '~/stores/planning'
import type { ApplySnapshot, PlanEntry } from '~/stores/planning'

const emit = defineEmits<{ changed: [dates: string[]] }>()

const planning = usePlanningStore()
const toast = useToast()

// ── Dates ────────────────────────────────────────────────────────────────────

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function short(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const today = computed(localToday)
const gridMonday = computed(() => planning.plans[0]?.date ?? today.value)
const gridEnd = computed(() => planning.plans.at(-1)?.date ?? today.value)

// ── Availability (needs a stored training plan) ──────────────────────────────

const hasPlan = ref(true)
onMounted(async () => {
  try {
    hasPlan.value = !!(await $fetch<{ trainingPlan: string | null }>('/api/users/me')).trainingPlan?.trim()
  }
  catch { /* leave enabled; the endpoint will 422 if there really is no plan */ }
})

// ── Config state ─────────────────────────────────────────────────────────────

const root = ref<HTMLElement | null>(null)
const startMonday = ref('')
const count = ref(1)
const override = ref<number | null>(null)
const guidance = ref('')
const progression = ref<number[] | null>(null)
const progressionLoaded = ref(false)

const phase = computed(() => planning.suggestPhase)
const blockLength = computed(() => progression.value?.length ?? 4)

const weekGroups = computed(() => {
  const out: { monday: string, days: typeof planning.plans }[] = []
  for (let i = 0; i < planning.plans.length; i += 7) {
    out.push({ monday: planning.plans[i]!.date, days: planning.plans.slice(i, i + 7) })
  }
  return out
})

const hasContent = (p: PlanEntry | null) => !!p && !!(p.name || p.type || p.tss != null || p.durationMinutes != null || p.notes)
const plannedCount = (monday: string) =>
  weekGroups.value.find(w => w.monday === monday)?.days.filter(d => hasContent(d.plan)).length ?? 0

/** Current week through current+5. */
const weekOptions = computed(() => Array.from({ length: 6 }, (_, i) => {
  const monday = addDays(gridMonday.value, i * 7)
  const beyond = monday > gridEnd.value
  let meta: string
  if (i === 0) {
    const dow = new Date(`${today.value}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
    meta = today.value === monday ? 'This week' : `This week · ${dow}–Sun`
  }
  else if (beyond) meta = 'Not in plan yet'
  else meta = plannedCount(monday) ? `${plannedCount(monday)} planned` : 'Empty'
  return { monday, meta, beyond }
}))

function defaultStart() {
  const next = weekOptions.value.slice(1).find(w => plannedCount(w.monday) < 7)
  return (next ?? weekOptions.value[1])!.monday
}

// ── Block-position detection ─────────────────────────────────────────────────

function summarize(w: { monday: string, days: typeof planning.plans }): WeekSummary {
  return {
    monday: w.monday,
    names: w.days.flatMap(d => (d.plan?.name ? [d.plan.name] : [])),
    tss: w.days.reduce((sum, d) => sum + (d.isPast ? (d.actual?.tss ?? 0) : (d.plan?.tss ?? 0)), 0),
  }
}

const detection = computed(() => {
  const previous = weekGroups.value.filter(w => w.monday < startMonday.value).reverse().map(summarize)
  return detectBlockPosition(previous, blockLength.value, progression.value)
})

const position = computed(() => override.value ?? detection.value.position)

const SLOT_NAMES = computed(() => Array.from({ length: blockLength.value }, (_, i) =>
  i === blockLength.value - 1 ? 'Recovery' : `Build ${i + 1}`))
const slotName = (slot: number) => SLOT_NAMES.value[slot % blockLength.value]!

const explanation = computed(() => {
  const start = short(startMonday.value)
  if (override.value != null) return `Set by you. ${start} starts at week ${override.value + 1} of the block.`
  const d = detection.value
  if (d.source === 'none' || !d.basedOn) return `Nothing before ${start} looks like a build week, so this starts a new block.`
  const verb = d.source === 'keyword' ? 'is labelled' : 'looks like'
  const which = d.weekNumber === blockLength.value ? 'the recovery week' : `week ${d.weekNumber}`
  return `${short(d.basedOn)} ${verb} ${which}, so ${start} continues at week ${position.value + 1}.`
})

/** Weeks to show inside each block slot: earlier weeks before the start, then the generated ones. */
const slots = computed(() => Array.from({ length: blockLength.value }, (_, j) => {
  const items: { label: string, generated: boolean, planned: boolean }[] = []
  const behind = position.value - j
  if (behind > 0) {
    const monday = addDays(startMonday.value, -behind * 7)
    items.push({ label: short(monday), generated: false, planned: plannedCount(monday) > 0 })
  }
  for (let i = 0; i < count.value; i++) {
    if ((position.value + i) % blockLength.value === j) {
      items.push({ label: short(addDays(startMonday.value, i * 7)), generated: true, planned: true })
    }
  }
  return items
}))

// ── Range ────────────────────────────────────────────────────────────────────

const rangeEnd = computed(() => addDays(startMonday.value, count.value * 7 - 1))
const rangeText = computed(() => `${short(startMonday.value)} – ${short(rangeEnd.value)}`)
const finishCount = computed(() => blockLength.value - position.value)
const showFinish = computed(() => finishCount.value >= 1 && finishCount.value <= 4 && count.value !== finishCount.value)

const rangeDays = computed(() => {
  const out: string[] = []
  for (let d = startMonday.value; d <= rangeEnd.value; d = addDays(d, 1)) if (d >= today.value) out.push(d)
  return out
})
const occupied = computed(() => rangeDays.value.filter((d) => {
  const day = planning.plans.find(p => p.date === d)
  return day && !day.isPast && hasContent(day.plan)
}).length)
const extraWeeks = computed(() => rangeEnd.value > gridEnd.value
  ? Math.ceil((new Date(`${rangeEnd.value}T00:00:00Z`).getTime() - new Date(`${gridEnd.value}T00:00:00Z`).getTime()) / 86_400_000 / 7)
  : 0)

watch(startMonday, () => {
  override.value = null
  count.value = Math.min(count.value, 4)
})

// ── Open / close ─────────────────────────────────────────────────────────────

async function openConfig() {
  if (!hasPlan.value || phase.value !== 'idle') return
  startMonday.value = defaultStart()
  count.value = 1
  override.value = null
  planning.suggestPhase = 'config'
  if (!progressionLoaded.value) {
    try {
      progression.value = (await $fetch<{ weeklyTss: number[] | null }>('/api/coach/block-progression')).weeklyTss
    }
    catch { /* TSS fallback just stays off */ }
    progressionLoaded.value = true
  }
}

function cancelConfig() {
  if (phase.value === 'config') planning.suggestPhase = 'idle'
}

function onPointerDown(e: PointerEvent) {
  if (phase.value === 'config' && root.value && !root.value.contains(e.target as Node)) cancelConfig()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (confirmOpen.value) confirmOpen.value = false
  else cancelConfig()
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('keydown', onKeydown)
})

// ── Generate ─────────────────────────────────────────────────────────────────

interface Request { startDate: string, weeks: number, blockPosition: number, blockLength: number, guidance: string }
let lastRequest: Request | null = null
const generating = ref(false)

function startGenerate() {
  lastRequest = {
    startDate: startMonday.value,
    weeks: count.value,
    blockPosition: position.value,
    blockLength: blockLength.value,
    guidance: guidance.value.trim(),
  }
  return runGenerate()
}

async function runGenerate() {
  const req = lastRequest!
  planning.suggestWeeks = Array.from({ length: req.weeks }, (_, i) => ({
    monday: addDays(req.startDate, i * 7),
    label: slotName(req.blockPosition + i),
  }))
  planning.suggestPhase = 'generating'
  generating.value = true
  // Regenerate keeps the grid extension from the first run; hide the old draft meanwhile.
  const base = planning.plans.length
  if (planning.draft) planning.setDraft({}, base)
  try {
    const res = await $fetch<{ weeks: { days: ({ date: string } & PlanEntry)[] }[] }>('/api/coach/generate-plan', {
      method: 'POST',
      body: { ...req, today: localToday() },
    })
    const end = addDays(req.startDate, req.weeks * 7 - 1)
    planning.extendTo(end)
    const entries: Record<string, PlanEntry> = {}
    for (const w of res.weeks) {
      for (const d of w.days) {
        const day = planning.plans.find(p => p.date === d.date)
        if (!day || day.isPast || (!d.name && !d.type && d.tss == null && d.durationMinutes == null)) continue
        entries[d.date] = {
          name: d.name ?? null, type: d.type ?? null, tss: d.tss ?? null,
          durationMinutes: d.durationMinutes ?? null, notes: d.notes ?? null,
        }
      }
    }
    planning.setDraft(entries, base)
    planning.suggestPhase = 'preview'
  }
  catch {
    planning.discardDraft()
    planning.suggestPhase = 'error'
  }
  finally {
    generating.value = false
  }
}

// ── Preview action bar ───────────────────────────────────────────────────────

const draftEntries = computed(() => Object.entries(planning.draft ?? {}))
const draftTss = computed(() => draftEntries.value.reduce((sum, [, e]) => sum + (e.tss ?? 0), 0))
const conflicts = computed(() => (phase.value === 'preview' ? planning.draftConflicts() : []))

const barTitle = computed(() => {
  const req = lastRequest
  if (!req) return ''
  const range = `${short(req.startDate)} – ${short(addDays(req.startDate, req.weeks * 7 - 1))}`
  const first = req.blockPosition + 1
  const last = req.blockPosition + req.weeks
  const where = last > req.blockLength
    ? `Week ${first} onward`
    : req.weeks === 1 ? `Week ${first} of block` : `Weeks ${first}–${last} of block`
  return `${range} · ${where}`
})

const barMeta = computed(() => {
  const req = lastRequest
  if (!req || !planning.draft) return ''
  const end = addDays(req.startDate, req.weeks * 7 - 1)
  const before = planning.projectCtl(null)[end]
  const after = planning.projectCtl(planning.draft)[end]
  const parts = [`${req.weeks} week${req.weeks > 1 ? 's' : ''}`, `${draftTss.value} TSS`]
  if (before != null && after != null) parts.push(`CTL ${Math.round(before)} → ${Math.round(after)} by ${short(end)}`)
  if (conflicts.value.length) parts.push(`${conflicts.value.length} replaced`)
  return parts.join(' · ')
})

function discard() {
  planning.discardDraft()
}

// ── Confirm + apply + undo ───────────────────────────────────────────────────

const confirmOpen = ref(false)
const choice = ref<'replace' | 'fill'>('replace')
const applying = ref(false)

function onApply() {
  if (conflicts.value.length) {
    choice.value = 'replace'
    confirmOpen.value = true
  }
  else {
    apply('replace')
  }
}

async function apply(mode: 'replace' | 'fill') {
  if (applying.value) return
  applying.value = true
  const weeksApplied = lastRequest?.weeks ?? 0
  try {
    const { updated, ...snapshot } = await planning.applyDraft(mode)
    confirmOpen.value = false
    emit('changed', snapshot.changes.map(c => c.date))
    toast.add({
      title: `Applied ${weeksApplied} week${weeksApplied === 1 ? '' : 's'} · ${updated} day${updated === 1 ? '' : 's'} updated`,
      duration: 8000,
      actions: [{ label: 'Undo', color: 'primary', variant: 'link', onClick: () => undo(snapshot) }],
    })
  }
  catch {
    toast.add({ title: "Couldn't save the plan", description: 'Nothing was changed. Try applying again.', color: 'error' })
  }
  finally {
    applying.value = false
  }
}

async function undo(snapshot: ApplySnapshot) {
  try {
    await planning.undoApply(snapshot)
    emit('changed', snapshot.changes.map(c => c.date))
  }
  catch {
    toast.add({ title: "Couldn't undo", description: 'Your plan was left as applied.', color: 'error' })
  }
}

const fmtEntry = (e: PlanEntry | null) => e ? `${e.name ?? 'Workout'}${e.tss != null ? ` · ${e.tss}` : ''}` : '—'
const fmtDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      :disabled="!hasPlan || (phase !== 'idle' && phase !== 'config')"
      :title="hasPlan ? undefined : 'Add a training plan in Settings first'"
      class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-semibold text-orange-700 transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50"
      :class="phase === 'config' ? 'border-orange-300 bg-orange-50' : 'border-stone-200 bg-white hover:bg-orange-50'"
      @click="phase === 'config' ? cancelConfig() : openConfig()"
    >
      <UIcon name="i-heroicons-sparkles" class="w-3.5 h-3.5" />
      Suggest plan
    </button>

    <!-- Config popover (bottom sheet below sm) -->
    <div
      v-if="phase === 'config'"
      class="fixed inset-x-0 bottom-0 z-40 max-h-[85vh] overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-4 shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-auto sm:top-full sm:mt-2 sm:w-[360px] sm:rounded-xl"
      role="dialog"
      aria-label="Suggest plan"
    >
      <div class="space-y-3.5">
        <!-- Start from -->
        <div>
          <div class="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-stone-500">Start from</div>
          <div class="space-y-[3px]">
            <button
              v-for="opt in weekOptions"
              :key="opt.monday"
              type="button"
              class="flex h-8 w-full items-center justify-between rounded-lg border px-2.5 text-[13px] cursor-pointer transition-colors"
              :class="[
                opt.monday === startMonday
                  ? 'border-orange-400 bg-orange-50 text-orange-800'
                  : opt.monday > startMonday && opt.monday <= addDays(startMonday, (count - 1) * 7)
                    ? 'border-orange-200 bg-orange-50 text-orange-800'
                    : 'border-transparent text-stone-700 hover:bg-stone-50',
              ]"
              @click="startMonday = opt.monday"
            >
              <span class="flex items-center gap-2">
                Week of {{ short(opt.monday) }}
                <span v-if="opt.monday === startMonday" class="rounded bg-orange-200 px-1 text-[9px] font-bold tracking-wide text-orange-800">START</span>
              </span>
              <span class="text-[11.5px] text-stone-400">{{ opt.meta }}</span>
            </button>
          </div>
        </div>

        <!-- Weeks -->
        <div>
          <div class="flex items-center justify-between">
            <div>
              <div class="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-stone-500">Weeks</div>
              <div class="text-[12px] text-stone-500 tabular">{{ rangeText }}</div>
            </div>
            <div class="inline-flex items-center rounded-lg border border-stone-200">
              <button type="button" class="h-8 w-8 cursor-pointer text-stone-500 hover:bg-stone-50 disabled:opacity-30 disabled:cursor-default" :disabled="count <= 1" aria-label="Fewer weeks" @click="count--">
                <UIcon name="i-heroicons-minus" class="w-3.5 h-3.5" />
              </button>
              <span class="w-6 text-center text-sm font-semibold tabular text-stone-700">{{ count }}</span>
              <button type="button" class="h-8 w-8 cursor-pointer text-stone-500 hover:bg-stone-50 disabled:opacity-30 disabled:cursor-default" :disabled="count >= 4" aria-label="More weeks" @click="count++">
                <UIcon name="i-heroicons-plus" class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <button v-if="showFinish" type="button" class="mt-1 cursor-pointer text-[12px] font-medium text-orange-700 hover:underline" @click="count = finishCount">
            Finish block ({{ finishCount }} week{{ finishCount > 1 ? 's' : '' }})
          </button>
        </div>

        <!-- Block position -->
        <div>
          <div class="mb-1.5 flex items-center justify-between">
            <span class="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-stone-500">Block position</span>
            <button v-if="override != null" type="button" class="cursor-pointer text-[12px] font-medium text-orange-700 hover:underline" @click="override = null">Use detected</button>
          </div>
          <div class="grid gap-1.5" :style="{ gridTemplateColumns: `repeat(${blockLength}, minmax(0, 1fr))` }">
            <button
              v-for="(items, j) in slots"
              :key="j"
              type="button"
              class="min-h-[52px] cursor-pointer rounded-lg border px-1.5 py-1.5 text-left transition-colors"
              :class="items.some(i => i.generated)
                ? 'border-orange-400 bg-orange-50'
                : items.length ? 'border-stone-200 bg-stone-100' : 'border-dashed border-stone-300 bg-white'"
              @click="override = j"
            >
              <div class="text-[10.5px] font-semibold leading-tight text-stone-600">
                <span class="block">Week {{ j + 1 }}</span>{{ SLOT_NAMES[j] }}
              </div>
              <div
                v-for="(item, k) in items"
                :key="k"
                class="mt-0.5 text-[10.5px] tabular leading-tight"
                :class="item.generated ? 'font-semibold text-orange-700' : 'text-stone-400'"
              >
                {{ item.label }}
              </div>
            </button>
          </div>
          <p class="mt-1.5 text-[12px] text-stone-500">{{ explanation }}</p>
        </div>

        <!-- Guidance -->
        <div>
          <label class="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.07em] text-stone-500" for="plan-guidance">Guidance <span class="normal-case tracking-normal font-normal">(optional)</span></label>
          <textarea
            id="plan-guidance"
            v-model="guidance"
            rows="2"
            maxlength="500"
            placeholder="e.g. 3-hour sportive on Nov 1, keep Fridays off"
            class="w-full resize-none rounded-lg border border-stone-200 p-2 text-[13px] text-stone-700 placeholder-stone-300 outline-none focus:border-stone-400"
          />
        </div>

        <p class="text-[12px] text-stone-500">
          {{ occupied
            ? `${occupied} day${occupied > 1 ? 's' : ''} in this range already have workouts. You'll choose whether to replace them before anything is saved.`
            : 'Every day in this range is empty.' }}
          <template v-if="extraWeeks"> Adds {{ extraWeeks }} week{{ extraWeeks > 1 ? 's' : '' }} to the end of the plan.</template>
        </p>

        <div class="flex items-center justify-end gap-3">
          <button type="button" class="cursor-pointer text-sm text-stone-400 hover:text-stone-600" @click="cancelConfig">Cancel</button>
          <button type="button" class="h-8 cursor-pointer rounded-lg bg-orange-600 px-4 text-sm font-semibold text-white hover:bg-orange-700" @click="startGenerate">Generate</button>
        </div>
      </div>
    </div>

    <!-- Status / action bar -->
    <Teleport to="body">
      <div
        v-if="phase === 'generating' || phase === 'preview' || phase === 'error'"
        class="fixed bottom-4 left-4 right-4 z-40 mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-stone-900 px-4 py-3 shadow-2xl"
        role="status"
      >
        <template v-if="phase === 'generating'">
          <UIcon name="i-heroicons-arrow-path" class="animate-spin w-4 h-4 text-orange-300" />
          <span class="text-[13px] text-white">Building {{ planning.suggestWeeks.length }} week{{ planning.suggestWeeks.length > 1 ? 's' : '' }} from your training plan…</span>
        </template>

        <template v-else-if="phase === 'error'">
          <span class="flex-1 text-[13px] text-white">Couldn't build a plan. Try again.</span>
          <button type="button" class="cursor-pointer text-[13px] text-stone-300 hover:text-white" @click="planning.suggestPhase = 'idle'">Dismiss</button>
          <button type="button" class="cursor-pointer rounded-lg bg-orange-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-orange-500" @click="runGenerate">Retry</button>
        </template>

        <template v-else>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-semibold text-white">{{ barTitle }}</div>
            <div class="text-[12px] tabular text-stone-400">{{ barMeta }}</div>
          </div>
          <button type="button" class="cursor-pointer text-[13px] text-stone-300 hover:text-white" @click="discard">Discard</button>
          <button type="button" class="cursor-pointer rounded-lg border border-stone-700 px-3 py-1.5 text-[13px] text-stone-200 hover:bg-stone-800" @click="runGenerate">Regenerate</button>
          <button type="button" :disabled="applying" class="cursor-pointer rounded-lg bg-orange-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-orange-500 disabled:opacity-60" @click="onApply">Apply to plan</button>
        </template>
      </div>

      <!-- Overwrite confirm -->
      <div v-if="confirmOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Replace existing workouts">
        <div class="fixed inset-0 bg-stone-900/30" @click="confirmOpen = false" />
        <div class="relative w-full max-w-[440px] rounded-2xl bg-white p-[22px] shadow-xl">
          <h2 class="text-lg font-semibold text-stone-900">{{ conflicts.length }} day{{ conflicts.length > 1 ? 's' : '' }} already have workouts</h2>
          <p class="mt-0.5 text-sm text-stone-500">The suggestion covers days you've already planned.</p>

          <div class="my-3.5 max-h-48 overflow-y-auto rounded-lg border border-stone-100 text-[12.5px]">
            <div v-for="c in conflicts" :key="c.date" class="flex items-center gap-2 border-b border-stone-50 px-2.5 py-1.5 last:border-b-0">
              <span class="w-20 shrink-0 text-stone-500 tabular">{{ fmtDay(c.date) }}</span>
              <span class="min-w-0 flex-1 truncate text-stone-600">{{ fmtEntry(c.before) }}</span>
              <span class="text-stone-300">→</span>
              <span class="min-w-0 flex-1 truncate text-orange-700">{{ fmtEntry(c.after) }}</span>
            </div>
          </div>

          <div class="space-y-2">
            <label class="block cursor-pointer rounded-lg border p-3" :class="choice === 'replace' ? 'border-orange-400 bg-orange-50' : 'border-stone-200'">
              <input v-model="choice" type="radio" value="replace" class="sr-only">
              <div class="text-sm font-semibold text-stone-800">Replace them</div>
              <div class="text-[12.5px] text-stone-500">Use the suggestion for every day in the range.</div>
            </label>
            <label class="block cursor-pointer rounded-lg border p-3" :class="choice === 'fill' ? 'border-orange-400 bg-orange-50' : 'border-stone-200'">
              <input v-model="choice" type="radio" value="fill" class="sr-only">
              <div class="text-sm font-semibold text-stone-800">Keep mine</div>
              <div class="text-[12.5px] text-stone-500">Only fill the empty days. Your workouts stay as they are.</div>
            </label>
          </div>

          <div class="mt-4 flex items-center justify-end gap-3">
            <button type="button" class="cursor-pointer text-sm text-stone-400 hover:text-stone-600" @click="confirmOpen = false">Back to preview</button>
            <button type="button" :disabled="applying" class="cursor-pointer rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-60" @click="apply(choice)">
              {{ choice === 'replace' ? 'Replace and apply' : 'Fill empty days' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
