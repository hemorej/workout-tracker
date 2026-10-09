/**
 * Planning store (Pinia)
 *
 * Manages the 4-week training plan grid:
 *   - The list of planned days (28 days, current Monday + 3 weeks ahead)
 *   - Current CTL and ATL from the actual training history (used as the seed)
 *   - Projected CTL and TSB computed locally without a round-trip
 *
 * Actions:
 *   fetchPlans()         — loads the plan grid from the API
 *   savePlan(date, entry)— upserts a planned workout and recomputes projections
 *   clearPlan(date)      — removes a planned workout and recomputes projections
 *   setDraft / discardDraft / applyDraft / undoApply — the "Suggest plan" preview
 *                          overlay and its batch write (see below)
 *
 * The local recompute (recomputeProjections) uses the same EMA formula as the
 * server so draft TSS values update the projected numbers as the user types,
 * before anything is saved.
 */

import { defineStore } from 'pinia'

/** A single planned workout row as returned by the API */
export interface PlanEntry {
  id?: number
  name: string | null
  /** Training zone: 'zone2' | 'zone4' | 'zone5' | 'zone6' | 'rest' | 'outdoor' */
  type: string | null
  tss: number | null
  durationMinutes: number | null
  notes: string | null
}

/** One day in the 4-week planning grid */
export interface PlannedDay {
  /** ISO date string "YYYY-MM-DD" */
  date: string
  /** True when the date is before today (historical, read-only) */
  isPast: boolean
  /** Planned workout for this day, or null for an unplanned rest day */
  plan: PlanEntry | null
  /** Actually logged totals for this day. null for future days. */
  actual: { tss: number, durationMinutes: number } | null
  /** Projected Chronic Training Load after applying this day's planned TSS */
  projectedCtl: number
  /** Projected Training Stress Balance (CTL − ATL) at the start of this day */
  projectedTsb: number
}

/** What `applyDraft` changed, so `undoApply` can restore it exactly. */
export interface ApplySnapshot {
  /** Grid length before the preview appended any weeks */
  baseLength: number
  /** Pre-apply entry per touched date (null = the day had no plan) */
  changes: { date: string, before: PlanEntry | null }[]
}

function hasContent(p: PlanEntry | null | undefined): p is PlanEntry {
  return !!p && !!(p.name || p.type || p.tss != null || p.durationMinutes != null || p.notes)
}

/** Same session for conflict purposes: name, type and TSS (notes/duration don't count). */
export function sameSession(a: PlanEntry | null | undefined, b: PlanEntry | null | undefined) {
  return (a?.name ?? null) === (b?.name ?? null) && (a?.type ?? null) === (b?.type ?? null) && (a?.tss ?? null) === (b?.tss ?? null)
}

const plainEntry = (p: PlanEntry): PlanEntry => ({
  name: p.name, type: p.type, tss: p.tss, durationMinutes: p.durationMinutes, notes: p.notes,
})

/** EMA decay factors — must match the server-side constants in tss.ts (TrainingPeaks/Coggan PMC standard: TSS delta / N) */
const CTL_DECAY = 1 / 42
const ATL_DECAY = 1 / 7

export const usePlanningStore = defineStore('planning', () => {
  const plans = ref<PlannedDay[]>([])
  /** Current CTL from the actual training history — seed for future projections */
  const currentCtl = ref(0)
  /** Current ATL from the actual training history — seed for future projections */
  const currentAtl = ref(0)
  /**
   * "Suggest plan" preview overlay: date → suggested entry. The grid shows
   * `draft[date] ?? plan`; nothing is persisted until `applyDraft`.
   */
  const draft = ref<Record<string, PlanEntry> | null>(null)
  /** Where the Suggest-plan flow is; the grid dims/marks target weeks accordingly. */
  const suggestPhase = ref<'idle' | 'config' | 'generating' | 'preview' | 'error'>('idle')
  /** Weeks the suggestion targets (Monday + block-slot label such as "Build 2"). */
  const suggestWeeks = ref<{ monday: string, label: string }[]>([])
  /** Grid length before the preview appended weeks, so Discard can trim back. */
  const previewBaseLength = ref<number | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Loads the 4-week plan grid from GET /api/planned-workouts.
   * Populates plans, currentCtl, and currentAtl.
   *
   * `fetcher` defaults to the global `$fetch` for ordinary client-triggered
   * calls. The initial page load passes `useRequestFetch()` instead so the
   * call can run during SSR — plain `$fetch` in a server context doesn't
   * forward the incoming request's session cookie, so `requireUserSession`
   * would 401.
   */
  async function fetchPlans(fetcher: ReturnType<typeof useRequestFetch> = $fetch) {
    isLoading.value = true
    error.value = null
    try {
      const data = await fetcher<{ plans: PlannedDay[], currentCtl: number, currentAtl: number }>(
        '/api/planned-workouts',
      )
      plans.value = data.plans
      currentCtl.value = data.currentCtl
      currentAtl.value = data.currentAtl
    }
    catch (e: unknown) {
      error.value = e instanceof Error ? e.message : 'Failed to load plans'
    }
    finally {
      isLoading.value = false
    }
  }

  /**
   * Recomputes projected CTL/TSB for all future days in-place, without a fetch.
   * Past days keep their historical projections; the seed CTL/ATL for future days
   * is derived from the last past day (or currentCtl/currentAtl if none exist).
   *
   * Called after every save/clear so the grid reflects the latest planned load
   * immediately — no round-trip required.
   */
  function recomputeProjections() {
    let ctl = currentCtl.value
    let atl = currentAtl.value

    for (let i = 0; i < plans.value.length; i++) {
      const day = plans.value[i]!
      if (day.isPast) {
        // Carry the actual historical values forward as the seed
        ctl = day.projectedCtl
        atl = day.projectedCtl - day.projectedTsb
      }
      else {
        const tss = day.plan?.tss ?? 0
        ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
        atl = tss * ATL_DECAY + atl * (1 - ATL_DECAY)
        plans.value[i] = {
          ...day,
          projectedCtl: Math.round(ctl * 10) / 10,
          projectedTsb: Math.round((ctl - atl) * 10) / 10,
        }
      }
    }
  }

  /**
   * Upserts a planned workout via PUT /api/planned-workouts, then updates the
   * affected day in-place and recomputes all future projections.
   */
  async function savePlan(date: string, entry: PlanEntry) {
    await $fetch('/api/planned-workouts', {
      method: 'PUT',
      body: { date, ...entry },
    })
    // Update only the affected row in-place to avoid a full re-render
    const idx = plans.value.findIndex(p => p.date === date)
    if (idx !== -1) {
      plans.value[idx] = { ...plans.value[idx]!, plan: { ...entry } }
    }
    recomputeProjections()
  }

  /**
   * Deletes the planned workout for a given date via DELETE /api/planned-workouts/:date,
   * clears the plan in-place, and recomputes all future projections.
   */
  async function clearPlan(date: string) {
    await $fetch(`/api/planned-workouts/${date}`, { method: 'DELETE' })
    const idx = plans.value.findIndex(p => p.date === date)
    if (idx !== -1) {
      plans.value[idx] = { ...plans.value[idx]!, plan: null }
    }
    recomputeProjections()
  }

  function appendWeekRows() {
    const last = plans.value[plans.value.length - 1]
    if (!last) return
    const d = new Date(`${last.date}T00:00:00Z`)
    for (let i = 0; i < 7; i++) {
      d.setUTCDate(d.getUTCDate() + 1)
      plans.value.push({
        date: d.toISOString().slice(0, 10),
        isPast: false,
        plan: null,
        actual: null,
        projectedCtl: 0,
        projectedTsb: 0,
      })
    }
  }

  /**
   * Appends a blank week (7 unplanned future days) after the last day in the
   * grid and recomputes projections. Client-side only — nothing is persisted
   * until the user plans a day. A refetch returns whole weeks through the
   * last *saved* planned day (see GET /api/planned-workouts), so an appended
   * week survives a reload once any of its days has a saved row.
   */
  function addWeek() {
    appendWeekRows()
    recomputeProjections()
  }

  /** Appends whole weeks until the grid covers `date`. */
  function extendTo(date: string) {
    while (plans.value.length && plans.value[plans.value.length - 1]!.date < date) appendWeekRows()
    recomputeProjections()
  }

  /** Drops trailing weeks beyond `baseLength` that hold no planned workout. */
  function trimEmptyWeeks(baseLength: number) {
    while (
      plans.value.length > baseLength
      && plans.value.slice(-7).every(d => !d.isPast && !hasContent(d.plan))
    ) {
      plans.value.splice(-7, 7)
    }
    recomputeProjections()
  }

  /** Shows `entries` as a preview overlay. `baseLength` = grid length before any extendTo. */
  function setDraft(entries: Record<string, PlanEntry>, baseLength: number) {
    draft.value = entries
    if (previewBaseLength.value == null) previewBaseLength.value = baseLength
  }

  /** Clears the preview and removes weeks it appended. Nothing was saved, so nothing to undo. */
  function discardDraft() {
    const base = previewBaseLength.value
    draft.value = null
    previewBaseLength.value = null
    suggestPhase.value = 'idle'
    suggestWeeks.value = []
    if (base != null && plans.value.length > base) {
      plans.value.splice(base)
      recomputeProjections()
    }
  }

  /** Projected CTL per future date if `overlay` entries replaced the saved plan (read-only, no fetch). */
  function projectCtl(overlay: Record<string, PlanEntry> | null) {
    let ctl = currentCtl.value
    const out: Record<string, number> = {}
    for (const day of plans.value) {
      if (day.isPast) {
        ctl = day.projectedCtl
      }
      else {
        const e = overlay?.[day.date]
        const tss = e ? (e.tss ?? 0) : (day.plan?.tss ?? 0)
        ctl = tss * CTL_DECAY + ctl * (1 - CTL_DECAY)
      }
      out[day.date] = Math.round(ctl * 10) / 10
    }
    return out
  }

  /** Days where the draft would change an existing plan (future days only). */
  function draftConflicts() {
    if (!draft.value) return []
    return plans.value.flatMap((day) => {
      const next = draft.value![day.date]
      return next && !day.isPast && hasContent(day.plan) && !sameSession(day.plan, next)
        ? [{ date: day.date, before: day.plan, after: next }]
        : []
    })
  }

  /**
   * Writes the draft in one transaction (PUT /api/planned-workouts/batch).
   * 'replace' overwrites every differing day; 'fill' only writes empty days.
   * Returns a snapshot for `undoApply`. Throws (draft kept) if the write fails.
   */
  async function applyDraft(mode: 'replace' | 'fill'): Promise<ApplySnapshot & { updated: number }> {
    const baseLength = previewBaseLength.value ?? plans.value.length
    const changes: ApplySnapshot['changes'] = []
    const entries: ({ date: string } & PlanEntry)[] = []
    for (const day of plans.value) {
      const next = draft.value?.[day.date]
      if (!next || day.isPast || (sameSession(day.plan, next) && hasContent(day.plan))) continue
      if (mode === 'fill' && hasContent(day.plan)) continue
      changes.push({ date: day.date, before: hasContent(day.plan) ? plainEntry(day.plan) : null })
      entries.push({ date: day.date, ...plainEntry(next) })
    }
    if (entries.length) {
      await $fetch('/api/planned-workouts/batch', { method: 'PUT', body: { entries } })
      for (const e of entries) {
        const idx = plans.value.findIndex(p => p.date === e.date)
        if (idx !== -1) plans.value[idx] = { ...plans.value[idx]!, plan: plainEntry(e) }
      }
    }
    draft.value = null
    previewBaseLength.value = null
    suggestPhase.value = 'idle'
    suggestWeeks.value = []
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
    for (const c of snapshot.changes) {
      const idx = plans.value.findIndex(p => p.date === c.date)
      if (idx !== -1) plans.value[idx] = { ...plans.value[idx]!, plan: c.before ? { ...c.before } : null }
    }
    trimEmptyWeeks(snapshot.baseLength)
  }

  return {
    plans, currentCtl, currentAtl, draft, suggestPhase, suggestWeeks, isLoading, error,
    fetchPlans, savePlan, clearPlan, addWeek, extendTo, setDraft, discardDraft, draftConflicts, projectCtl, applyDraft, undoApply,
  }
})
