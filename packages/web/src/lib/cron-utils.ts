/**
 * Cron schedule parsing and human-readable description utilities.
 * No external dependencies — covers the common patterns used in Jinn cron jobs.
 */

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

function formatTime(hour: number, minute: number): string {
  const h = hour % 12 || 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  const m = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`
  return `${h}${m} ${ampm}`
}

function formatTimeWithMinute(hour: number, minute: number): string {
  const h = hour % 12 || 12
  const ampm = hour < 12 ? 'AM' : 'PM'
  return `${h}:${String(minute).padStart(2, '0')} ${ampm}`
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 147116 -> "2m 27s", 45000 -> "45s", 3600000 -> "1h 0m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '\u2014'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

/** Minute-aware fire-time label: "9 AM" / "9:15 AM". */
function timeLabel(hour: number, minute: number): string {
  return minute === 0 ? formatTime(hour, minute) : formatTimeWithMinute(hour, minute)
}

function ordinal(n: number): string {
  const rem = n % 100
  if (rem >= 11 && rem <= 13) return `${n}th`
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** "a" / "a and b" / "a, b and c". */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function sortedAsc(set: Set<number>): number[] {
  return Array.from(set).sort((a, b) => a - b)
}

/** Equal spacing between ≥2 sorted values, or null. {9,11,13,15,17} → 2. */
function uniformStep(values: number[]): number | null {
  if (values.length < 2) return null
  const step = values[1] - values[0]
  for (let i = 2; i < values.length; i++) {
    if (values[i] - values[i - 1] !== step) return null
  }
  return step
}

/** Which days a dow set names: "Daily", "Weekdays", "Weekends", plural day
 *  names for small lists — or null when no honest short phrase exists. */
function dowPhrase(dow: Set<number>): string | null {
  if (dow.size === 7) return 'Daily'
  const days = sortedAsc(dow)
  if (days.length === 5 && days.every((d, i) => d === i + 1)) return 'Weekdays'
  if (days.length === 2 && days[0] === 0 && days[1] === 6) return 'Weekends'
  if (days.length <= 3) return listPhrase(days.map((d) => DAY_NAMES[d]))
  return null
}

/**
 * Convert a 5-field cron expression to a human-readable sentence built from
 * the same field expansion nextCronDate uses. Only says what is true: when a
 * schedule has no honest short sentence it returns "Custom schedule" (the UI
 * always shows the mono expression alongside) — never a wrong sentence, and
 * never the raw expression duplicated as prose.
 */
export function describeCron(schedule: string): string {
  if (!schedule || !schedule.trim()) return ''
  const parts = schedule.trim().split(/\s+/)
  const sets = parts.length === 5 ? parseCronFields(schedule) : null
  if (!sets) return 'Custom schedule'
  const [minF, , domF, monF] = parts

  // Month-restricted schedules have no honest short sentence.
  if (monF !== '*') return 'Custom schedule'

  const minutes = sortedAsc(sets.minute)
  const hours = sortedAsc(sets.hour)
  const allHours = hours.length === 24
  const allDays = !sets.domRestricted && !sets.dowRestricted

  // Sub-hourly grammar.
  if (minF === '*' && allHours && allDays) return 'Every minute'
  if (minF.startsWith('*/') && allHours && allDays) {
    const interval = parseInt(minF.slice(2), 10)
    if (!isNaN(interval)) return `Every ${interval} minutes`
  }
  if (minutes.length === 1 && allHours && allDays) return 'Every hour'
  if (minutes.length !== 1) return 'Custom schedule'
  const minute = minutes[0]

  // dom ∪ dow union (standard cron: either matches) — say the "or".
  if (sets.domRestricted && sets.dowRestricted) {
    const days = dowPhrase(sets.dow)
    if (hours.length === 1 && days && days !== 'Daily' && sets.dom.size === 1) {
      const [dom] = sets.dom
      return `${days} or the ${ordinal(dom)}, at ${timeLabel(hours[0], minute)}`
    }
    return 'Custom schedule'
  }

  // Day-of-month driven (dow is *).
  if (sets.domRestricted) {
    if (hours.length !== 1) return 'Custom schedule'
    const time = timeLabel(hours[0], minute)
    if (domF.startsWith('*/')) {
      const interval = parseInt(domF.slice(2), 10)
      if (!isNaN(interval)) return `Every ${interval} days at ${time}`
    }
    if (sets.dom.size === 1) {
      const [dom] = sets.dom
      return `Monthly on the ${ordinal(dom)} at ${time}`
    }
    return 'Custom schedule'
  }

  // Day-of-week driven.
  const phrase = dowPhrase(sets.dow)
  if (!phrase) return 'Custom schedule'
  if (hours.length === 1) return `${phrase} at ${timeLabel(hours[0], minute)}`
  if (allHours) return `${phrase} every hour`
  if (hours.length <= 3) return `${phrase} at ${listPhrase(hours.map((h) => timeLabel(h, minute)))}`
  const step = uniformStep(hours)
  if (step) {
    return `${phrase} every ${step}h, ${timeLabel(hours[0], minute)}–${timeLabel(hours[hours.length - 1], minute)}`
  }
  return 'Custom schedule'
}

/* ------------------------------------------------------------------ */
/*  Next-run computation                                               */
/*                                                                     */
/*  The gateway's scheduler (node-cron v3) exposes no next-fire time,  */
/*  so the Cron page computes it here: standard 5-field cron with      */
/*  lists/ranges/steps and the dom∪dow union rule, in the job's IANA   */
/*  timezone. Anything unparseable returns null — the UI shows nothing */
/*  rather than a wrong time.                                          */
/* ------------------------------------------------------------------ */

// Expand one cron field ("*", "*/N", "A", "A-B", "A-B/N", "A,B,C") into a
// Set of allowed values, or null when unparseable. `dow` 7 folds to 0.
function expandField(field: string, min: number, max: number, foldSeven = false): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = /^(.+?)\/(\d+)$/.exec(part)
    const base = stepMatch ? stepMatch[1] : part
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1
    if (!Number.isFinite(step) || step < 1) return null
    let lo: number
    let hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else {
      const range = /^(\d+)(?:-(\d+))?$/.exec(base)
      if (!range) return null
      lo = parseInt(range[1], 10)
      hi = range[2] !== undefined ? parseInt(range[2], 10) : stepMatch ? max : lo
    }
    if (lo < min || hi > max || lo > hi) return null
    // dow accepts 0-7 with 7 folding to Sunday at add time.
    for (let v = lo; v <= hi; v += step) out.add(foldSeven && v === 7 ? 0 : v)
  }
  return out.size > 0 ? out : null
}

export interface CronSets {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

export function parseCronFields(schedule: string): CronSets | null {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minF, hourF, domF, monF, dowF] = parts
  const minute = expandField(minF, 0, 59)
  const hour = expandField(hourF, 0, 23)
  const dom = expandField(domF, 1, 31)
  const month = expandField(monF, 1, 12)
  const dow = expandField(dowF, 0, 7, true)
  if (!minute || !hour || !dom || !month || !dow) return null
  return {
    minute, hour, dom, month, dow,
    domRestricted: domF !== '*',
    dowRestricted: dowF !== '*',
  }
}

interface WallClock {
  minute: number
  hour: number
  dom: number
  month: number
  dow: number
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function tzFormatter(timezone: string | undefined): Intl.DateTimeFormat | null {
  const key = timezone ?? ''
  const cached = dtfCache.get(key)
  if (cached) return cached
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      ...(timezone ? { timeZone: timezone } : {}),
      hour12: false,
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    })
    dtfCache.set(key, dtf)
    return dtf
  } catch {
    return null // unknown IANA name
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function wallClockAt(t: number, dtf: Intl.DateTimeFormat): WallClock {
  const parts = dtf.formatToParts(t)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    minute: parseInt(get('minute'), 10),
    // hour12:false can yield "24" at midnight in some engines; fold it.
    hour: parseInt(get('hour'), 10) % 24,
    dom: parseInt(get('day'), 10),
    month: parseInt(get('month'), 10),
    dow: WEEKDAYS[get('weekday')] ?? 0,
  }
}

/** Whether a calendar date satisfies the month/dom/dow fields. Standard cron:
 *  when BOTH dom and dow are restricted, either matching is enough. */
export function dateMatches(sets: CronSets, month: number, dom: number, dow: number): boolean {
  if (!sets.month.has(month)) return false
  if (sets.domRestricted && sets.dowRestricted) return sets.dom.has(dom) || sets.dow.has(dow)
  return sets.dom.has(dom) && sets.dow.has(dow)
}

function matches(w: WallClock, sets: CronSets): boolean {
  if (!sets.minute.has(w.minute) || !sets.hour.has(w.hour)) return false
  return dateMatches(sets, w.month, w.dom, w.dow)
}

const MINUTE = 60_000
const HOUR = 3_600_000
/** How far ahead to search before giving up (monthly jobs need ~31 days). */
const HORIZON_MS = 60 * 86_400_000

/**
 * The next instant a 5-field cron expression fires at or after `from`
 * (exclusive of `from`'s own minute), in `timezone` (defaults to the
 * browser's). Returns null for unparseable expressions, unknown timezones,
 * or nothing within 60 days.
 */
export function nextCronDate(schedule: string, timezone?: string, from: Date = new Date()): Date | null {
  const sets = parseCronFields(schedule)
  if (!sets) return null
  const dtf = tzFormatter(timezone)
  if (!dtf) return null

  // Start at the next whole minute after `from`.
  const start = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE
  const end = start + HORIZON_MS

  // Hour-block scan: check each hour's start; only minute-scan hours whose
  // hour/day/month could match (the wall hour at any minute of a UTC hour is
  // the start's hour or the one after it, for non-whole-hour tz offsets).
  for (let hourStart = start; hourStart < end; ) {
    const nextHour = Math.floor(hourStart / HOUR) * HOUR + HOUR
    const w = wallClockAt(hourStart, dtf)
    // Prefilter on hour only — day/month roll mid-block in half-hour-offset
    // timezones, so they're validated by the full minute-scan instead.
    const candidate = sets.hour.has(w.hour) || sets.hour.has((w.hour + 1) % 24)
    if (candidate) {
      for (let t = hourStart; t < nextHour && t < end; t += MINUTE) {
        if (matches(wallClockAt(t, dtf), sets)) return new Date(t)
      }
    }
    hourStart = nextHour
  }
  return null
}

/** Compact "at a glance" label for a next fire: "in 45m", "in 5h",
 *  "Mon 9 AM", "Aug 1". Empty string when `next` is null. */
export function formatNextRun(next: Date | null, now: Date = new Date()): string {
  if (!next) return ''
  const diff = next.getTime() - now.getTime()
  if (diff <= 0) return 'now'
  const mins = Math.round(diff / MINUTE)
  if (mins < 60) return `in ${mins}m`
  if (mins < 24 * 60) return `in ${Math.round(mins / 60)}h`
  if (diff < 7 * 86_400_000) {
    const day = next.toLocaleDateString('en-US', { weekday: 'short' })
    return `${day} ${formatTime(next.getHours(), next.getMinutes())}`
  }
  return next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Friendly absolute time for run history: "Today, 8:00 AM",
 *  "Yesterday, 8:00 AM", "Jul 9, 8:00 AM" (+year when not this year). */
export function formatRunTime(iso: string | number, now: Date = new Date()): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const time = formatTimeWithMinute(d.getHours(), d.getMinutes())
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff === 0) return `Today, ${time}`
  if (dayDiff === 1) return `Yesterday, ${time}`
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  return `${d.toLocaleDateString('en-US', opts)}, ${time}`
}

/** Relative "ran 2h ago" ago-label. Returns "" for missing input. */
export function agoLabel(iso: string | number | null | undefined, now: Date = new Date()): string {
  if (iso == null || iso === '') return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diff = now.getTime() - d.getTime()
  if (diff < MINUTE) return 'just now'
  const mins = Math.floor(diff / MINUTE)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
