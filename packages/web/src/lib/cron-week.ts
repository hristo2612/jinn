/**
 * Expanding a cron schedule onto the Cron page's weekly grid.
 *
 * Split out of cron-utils.ts, which keeps the field parsing and the
 * next-run/prose sides. The grid draws one *real* week, so this is the only
 * place that resolves a schedule against calendar dates rather than against a
 * generic Mon–Sun.
 */

import { dateMatches, parseCronFields, sortedAsc } from "./cron-utils"

/** True per-day fire cap before the weekly grid aggregates a job into a
 *  single counted pill (so `* * * * *` cannot explode the view). */
export const MAX_WEEKLY_PILLS_PER_DAY = 8

export interface WeeklySlots {
  /** Distinct (hour, minute) fire slots within one active day, ascending. */
  slots: { hour: number; minute: number }[]
  /** Days of week the job fires on (0=Sun..6=Sat), empty when the schedule
   *  does not fire in the week it was expanded against. */
  days: number[]
  /** Set when the job fires more than MAX_WEEKLY_PILLS_PER_DAY times a day:
   *  `slots` collapses to the first fire and this carries the true per-day
   *  count for an aggregated pill. */
  aggregatedCount?: number
}

/**
 * The seven calendar dates of the week containing `day`, Monday first — the
 * order the weekly grid's columns are in. Local dates, matching the wall-clock
 * hours the grid renders.
 */
export function weekDatesFor(day: Date): Date[] {
  const mondayOffset = (day.getDay() + 6) % 7 // Sun (0) is six days into the week
  return Array.from(
    { length: 7 },
    (_, i) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - mondayOffset + i),
  )
}

/**
 * Expand a 5-field cron expression into the slots the weekly grid draws for
 * `weekDates` — the seven real dates its columns stand for, from
 * `weekDatesFor`. Field expansion is the one nextCronDate schedules by (lists,
 * ranges, steps, dow 7→0), and day-of-month/month are resolved against those
 * dates under the same dom∪dow union rule, so a monthly job lands on the one
 * column that holds its fire and on no column in the weeks between. Returns
 * null for unparseable expressions.
 */
export function weeklyScheduleSlots(schedule: string, weekDates: Date[]): WeeklySlots | null {
  const sets = parseCronFields(schedule)
  if (!sets) return null
  const days = weekDates
    .filter((date) => dateMatches(sets, date.getMonth() + 1, date.getDate(), date.getDay()))
    .map((date) => date.getDay())
    .sort((a, b) => a - b)
  const hours = sortedAsc(sets.hour)
  const minutes = sortedAsc(sets.minute)
  const perDay = hours.length * minutes.length
  if (perDay > MAX_WEEKLY_PILLS_PER_DAY) {
    return { slots: [{ hour: hours[0], minute: minutes[0] }], days, aggregatedCount: perDay }
  }
  return {
    slots: hours.flatMap((hour) => minutes.map((minute) => ({ hour, minute }))),
    days,
  }
}
