/**
 * Training store (Pinia) — the Training tab's day list.
 *
 * `days` is an ascending, contiguous run of whole Monday–Sunday weeks, each day
 * merging the planned session and the logged ride (see TrainingDay). The initial
 * window is last week → the next two weeks (more when later days are planned);
 * older weeks are prepended on demand and "Add week" appends blank ones.
 *
 * Actions:
 *   fetchInitial / loadOlder / refreshFrom  — load and refresh the range
 *   addWorkout / updateWorkout / deleteWorkout — ride writes, then refresh from that day on
 *   savePlan / clearPlan / swapPlans        — plan writes; projections recompute locally
 *   addWeek / extendTo                      — append blank weeks (client-side until a day is saved)
 *   setDraft / discardDraft / draftConflicts / project / applyDraft / undoApply
 *                                           — the "Suggest plan" preview overlay and its batch write
 *
 * Projections use the same EMA constants as server/utils/tss.ts, so edits show
 * their effect on CTL/TSB without a round-trip.
 */

import { defineStore } from 'pinia'
import type {
  FormMetrics, NewWorkoutPayload, PlanEntry, TrainingDay, TrainingDaysResponse, TrainingSummary,
} from '#shared/types/training'

/** What `applyDraft` changed, so `undoApply` can restore it exactly. */
export interface ApplySnapshot {
  /** Day count before the preview appended any weeks */
  baseLength: number
  /** Pre-apply entry per touched date (null = the day had no plan) */
  changes: { date: string, before: PlanEntry | null }[]
}

export function hasContent(p: PlanEntry | null | undefined): p is PlanEntry {
  return !!p && !!(p.name || p.type || p.tss != null || p.durationMinutes != null || p.notes)
}

/** Same session for conflict purposes: name, type and TSS (notes/duration don't count). */
export function sameSession(a: PlanEntry | null | undefined, b: PlanEntry | null | undefined) {
  return (a?.name ?? null) === (b?.name ?? null) && (a?.type ?? null) === (b?.type ?? null) && (a?.tss ?? null) === (b?.tss ?? null)
}

const plainEntry = (p: PlanEntry): PlanEntry => ({
  name: p.name, type: p.type, tss: p.tss, durationMinutes: p.durationMinutes, notes: p.notes,
})

/** EMA decay factors — must match server/utils/tss.ts (TrainingPeaks/Coggan PMC: TSS delta / N) */
const CTL_DECAY = 1 / 42
const ATL_DECAY = 1 / 7
const round1 = (n: number) => Math.round(n * 10) / 10

/** Weeks fetched per "older weeks" load, and the server's per-request cap. */
const OLDER_WEEKS = 4
const MAX_FETCH_WEEKS = 52

const EMPTY_FORM: FormMetrics = { ctl: 0, atl: 0, tsb: 0 }

const blankDay = (date: string): TrainingDay => ({
  date, plan: null, ride: null, metrics: EMPTY_FORM, isToday: false, isPast: false,
})

export const useTrainingStore = defineStore('training', () => {
  const days = ref<TrainingDay[]>([])
  const summary = ref<TrainingSummary>({ today: EMPTY_FORM, weekAgo: null, ctlRange: null })
  const hasOlder = ref(false)
  const isLoading = ref(false)
  const isLoadingOlder = ref(false)
  const error = ref<string | null>(null)
  /** Bumped whenever a write changed `days`, so views of copies (search results) can refresh. */
  const revision = ref(0)

  /** "Suggest plan" preview overlay: date → suggested entry. Nothing persists until `applyDraft`. */
  const draft = ref<Record<string, PlanEntry> | null>(null)
  const suggestPhase = ref<'idle' | 'config' | 'generating' | 'preview' | 'error'>('idle')
  /** Weeks the suggestion targets (Monday + block-slot label such as "Build 2"). */
  const suggestWeeks = ref<{ monday: string, label: string }[]>([])
  /** Day count before the preview appended weeks, so Discard can trim back. */
  const previewBaseLength = ref<number | null>(null)

  const currentMonday = computed(() => mondayOf(days.value.find(d => d.isToday)?.date ?? localDateIso()))
  const currentWeek = computed(() => days.value.filter(d => mondayOf(d.date) === currentMonday.value))

  // ── Loading ────────────────────────────────────────────────────────────────

  /**
   * Loads the initial window. `fetcher` defaults to `$fetch`; SSR passes
   * `useRequestFetch()` so the session cookie is forwarded.
   */
  async function fetchInitial(fetcher: ReturnType<typeof useRequestFetch> = $fetch) {
    isLoading.value = true
    error.value = null
    try {
      const data = await fetcher<TrainingDaysResponse>('/api/training/days')
      days.value = data.days
      summary.value = data.summary
      hasOlder.value = data.hasOlder
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load training'
    }
    finally {
      isLoading.value = false
    }
  }

  /** Prepends the previous OLDER_WEEKS weeks. Returns false when there was nothing to load. */
  async function loadOlder() {
    const first = days.value[0]
    if (!first || !hasOlder.value || isLoadingOlder.value) return false
    isLoadingOlder.value = true
    try {
      const data = await $fetch<TrainingDaysResponse>('/api/training/days', {
        query: { from: addDaysIso(first.date, -OLDER_WEEKS * 7), to: addDaysIso(first.date, -1) },
      })
      days.value = [...data.days, ...days.value]
      hasOlder.value = data.hasOlder
      return true
    }
    finally {
      isLoadingOlder.value = false
    }
  }

  /**
   * Re-fetches every loaded day from `date`'s week to the end — a ride write
   * shifts CTL/ATL/TSB for everything after it — and refreshes the summary.
   */
  async function refreshFrom(date: string) {
    const from = mondayOf(date)
    const last = days.value.at(-1)?.date
    if (!last || last < from) return
    const fetched: TrainingDay[] = []
    for (let start = from; start <= last; start = addDaysIso(start, MAX_FETCH_WEEKS * 7)) {
      const chunkEnd = addDaysIso(start, MAX_FETCH_WEEKS * 7 - 1)
      const data = await $fetch<TrainingDaysResponse>('/api/training/days', {
        query: { from: start, to: chunkEnd < last ? chunkEnd : last },
      })
      fetched.push(...data.days)
      summary.value = data.summary
    }
    const idx = Math.max(0, days.value.findIndex(d => d.date === from))
    days.value = [...days.value.slice(0, idx), ...fetched]
    revision.value++
  }

  // ── Rides ──────────────────────────────────────────────────────────────────

  async function addWorkout(payload: NewWorkoutPayload) {
    await $fetch('/api/workouts', { method: 'POST', body: payload })
    await refreshFrom(payload.date)
  }

  /** PATCHes (full replace of) a workout; refreshes from whichever of its old/new date is earlier. */
  async function updateWorkout(id: number, payload: NewWorkoutPayload) {
    const oldDate = days.value.find(d => d.ride?.id === id)?.date ?? payload.date
    await $fetch(`/api/workouts/${id}`, { method: 'PATCH', body: payload })
    await refreshFrom(oldDate < payload.date ? oldDate : payload.date)
  }

  async function deleteWorkout(id: number) {
    const date = days.value.find(d => d.ride?.id === id)?.date
    await $fetch(`/api/workouts/${id}`, { method: 'DELETE' })
    if (date) await refreshFrom(date)
  }

  // ── Plans & projections ────────────────────────────────────────────────────

  /**
   * Metrics for every day if `overlay` entries replaced the saved plans.
   * Actual days (ridden / past) keep their real values and seed the carry.
   */
  function project(overlay: Record<string, PlanEntry> | null): Record<string, FormMetrics> {
    let ctl = summary.value.today.ctl
    let atl = summary.value.today.atl
    const out: Record<string, FormMetrics> = {}
    for (const day of days.value) {
      if (isActualDay(day)) {
        ({ ctl, atl } = day.metrics)
        out[day.date] = day.metrics
        continue
      }
      const tss = (overlay?.[day.date] ?? day.plan)?.tss ?? 0
      ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
      atl = tss * ATL_DECAY + atl * (1 - ATL_DECAY)
      out[day.date] = { ctl: round1(ctl), atl: round1(atl), tsb: round1(ctl - atl) }
    }
    return out
  }

  /** Writes the projected metrics of every non-actual day back into `days`. */
  function recomputeProjections() {
    const projected = project(null)
    days.value = days.value.map((d) => {
      const m = projected[d.date]!
      return isActualDay(d) || (m.ctl === d.metrics.ctl && m.tsb === d.metrics.tsb) ? d : { ...d, metrics: m }
    })
  }

  function setPlan(date: string, plan: PlanEntry | null) {
    const idx = days.value.findIndex(d => d.date === date)
    if (idx !== -1) days.value[idx] = { ...days.value[idx]!, plan }
    revision.value++
  }

  /** Upserts a planned workout, then recomputes projections. */
  async function savePlan(date: string, entry: PlanEntry) {
    await $fetch('/api/planned-workouts', { method: 'PUT', body: { date, ...entry } })
    setPlan(date, { ...entry })
    recomputeProjections()
  }

  async function clearPlan(date: string) {
    await $fetch(`/api/planned-workouts/${date}`, { method: 'DELETE' })
    setPlan(date, null)
    recomputeProjections()
  }

  /** Swaps the plans of two days (either may be empty). */
  async function swapPlans(a: string, b: string) {
    const planA = days.value.find(d => d.date === a)?.plan ?? null
    const planB = days.value.find(d => d.date === b)?.plan ?? null
    const write = (date: string, plan: PlanEntry | null) => plan ? savePlan(date, plainEntry(plan)) : clearPlan(date)
    await Promise.all([write(a, planB), write(b, planA)])
  }

  function appendWeekRows() {
    const last = days.value.at(-1)
    if (!last) return
    for (let i = 1; i <= 7; i++) days.value.push(blankDay(addDaysIso(last.date, i)))
  }

  /** Appends a blank week. Client-side only — it survives a reload once any of its days has a saved plan. */
  function addWeek() {
    appendWeekRows()
    recomputeProjections()
  }

  /** Appends whole weeks until the list covers `date`. */
  function extendTo(date: string) {
    while (days.value.length && days.value[days.value.length - 1]!.date < date) appendWeekRows()
    recomputeProjections()
  }

  /** Drops trailing weeks beyond `baseLength` that hold no planned workout. */
  function trimEmptyWeeks(baseLength: number) {
    while (
      days.value.length > baseLength
      && days.value.slice(-7).every(d => !isActualDay(d) && !hasContent(d.plan))
    ) {
      days.value.splice(-7, 7)
    }
    recomputeProjections()
  }

  // ── Suggest-plan preview ───────────────────────────────────────────────────

  /** Shows `entries` as a preview overlay. `baseLength` = day count before any extendTo. */
  function setDraft(entries: Record<string, PlanEntry>, baseLength: number) {
    draft.value = entries
    if (previewBaseLength.value == null) previewBaseLength.value = baseLength
  }

  function resetSuggest() {
    draft.value = null
    previewBaseLength.value = null
    suggestPhase.value = 'idle'
    suggestWeeks.value = []
  }

  /** Clears the preview and removes weeks it appended. Nothing was saved, so nothing to undo. */
  function discardDraft() {
    const base = previewBaseLength.value
    resetSuggest()
    if (base != null && days.value.length > base) {
      days.value.splice(base)
      recomputeProjections()
    }
  }

  /** Days where the draft would change an existing plan (editable days only). */
  function draftConflicts() {
    if (!draft.value) return []
    return days.value.flatMap((day) => {
      const next = draft.value![day.date]
      return next && !isActualDay(day) && hasContent(day.plan) && !sameSession(day.plan, next)
        ? [{ date: day.date, before: day.plan, after: next }]
        : []
    })
  }

  /**
   * Writes the draft in one transaction. 'replace' overwrites every differing
   * day; 'fill' only writes empty days. Throws (draft kept) if the write fails.
   */
  async function applyDraft(mode: 'replace' | 'fill'): Promise<ApplySnapshot & { updated: number }> {
    const baseLength = previewBaseLength.value ?? days.value.length
    const changes: ApplySnapshot['changes'] = []
    const entries: ({ date: string } & PlanEntry)[] = []
    for (const day of days.value) {
      const next = draft.value?.[day.date]
      if (!next || isActualDay(day) || (sameSession(day.plan, next) && hasContent(day.plan))) continue
      if (mode === 'fill' && hasContent(day.plan)) continue
      changes.push({ date: day.date, before: hasContent(day.plan) ? plainEntry(day.plan) : null })
      entries.push({ date: day.date, ...plainEntry(next) })
    }
    if (entries.length) {
      await $fetch('/api/planned-workouts/batch', { method: 'PUT', body: { entries } })
      for (const e of entries) setPlan(e.date, plainEntry(e))
    }
    resetSuggest()
    recomputeProjections()
    return { baseLength, changes, updated: entries.length }
  }

  /** Restores the exact pre-apply entries and trims weeks that are empty again. */
  async function undoApply(snapshot: ApplySnapshot) {
    const entries = snapshot.changes.filter(c => c.before).map(c => ({ date: c.date, ...c.before! }))
    const deleteDates = snapshot.changes.filter(c => !c.before).map(c => c.date)
    if (entries.length || deleteDates.length) {
      await $fetch('/api/planned-workouts/batch', { method: 'PUT', body: { entries, deleteDates } })
    }
    for (const c of snapshot.changes) setPlan(c.date, c.before ? { ...c.before } : null)
    trimEmptyWeeks(snapshot.baseLength)
  }

  return {
    days, summary, hasOlder, isLoading, isLoadingOlder, error, revision, draft, suggestPhase, suggestWeeks,
    currentMonday, currentWeek,
    fetchInitial, loadOlder, refreshFrom, addWorkout, updateWorkout, deleteWorkout,
    project, savePlan, clearPlan, swapPlans, addWeek, extendTo, setDraft, discardDraft, draftConflicts, applyDraft, undoApply,
  }
})
