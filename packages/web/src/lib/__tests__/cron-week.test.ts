import { describe, expect, it } from "vitest"
import { MAX_WEEKLY_PILLS_PER_DAY, weekDatesFor, weeklyScheduleSlots } from "../cron-week"

/* The weekly grid draws one real Mon–Sun week, so these expand against
 * calendar dates rather than a generic week. */

describe("weekDatesFor", () => {
  it("returns Monday..Sunday of the week that contains the given day", () => {
    // Sat 2026-08-29 sits in the week Mon 2026-08-24 .. Sun 2026-08-30.
    const week = weekDatesFor(new Date(2026, 7, 29))
    expect(week.map((d) => d.getDate())).toEqual([24, 25, 26, 27, 28, 29, 30])
    expect(week.map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5, 6, 0])
  })

  it("treats Sunday as the last column, not the first", () => {
    const week = weekDatesFor(new Date(2026, 7, 30)) // Sun 2026-08-30
    expect(week[0].getDate()).toBe(24)
    expect(week[6].getDate()).toBe(30)
  })

  it("crosses a month boundary", () => {
    // Mon 2026-08-31 .. Sun 2026-09-06.
    const week = weekDatesFor(new Date(2026, 8, 2))
    expect(week.map((d) => `${d.getMonth() + 1}/${d.getDate()}`)).toEqual([
      "8/31", "9/1", "9/2", "9/3", "9/4", "9/5", "9/6",
    ])
  })
})

describe("weeklyScheduleSlots", () => {
  /** dom/month are `*` in these fixtures, so any week gives the same answer. */
  const ANY_WEEK = weekDatesFor(new Date(2026, 6, 8))

  it("expands range/step schedules into every fire slot (QA r2-1)", () => {
    const w = weeklyScheduleSlots("15 9-17/2 * * 1-5", ANY_WEEK)!
    expect(w.days).toEqual([1, 2, 3, 4, 5])
    expect(w.slots).toEqual([9, 11, 13, 15, 17].map((hour) => ({ hour, minute: 15 })))
    expect(w.aggregatedCount).toBeUndefined()
    // 5 hour-slots × 5 weekdays → 25 weekly pills.
    expect(w.slots.length * w.days.length).toBe(25)
  })

  it("keeps simple dailies as one slot across all days", () => {
    const w = weeklyScheduleSlots("0 8 * * *", ANY_WEEK)!
    expect(w.slots).toEqual([{ hour: 8, minute: 0 }])
    expect(w.days).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it("aggregates dense schedules instead of exploding the grid", () => {
    const every = weeklyScheduleSlots("* * * * *", ANY_WEEK)!
    expect(every.aggregatedCount).toBe(1440)
    expect(every.slots).toHaveLength(1)

    const quarterHourly = weeklyScheduleSlots("*/15 9-17 * * *", ANY_WEEK)!
    expect(quarterHourly.aggregatedCount).toBe(36) // 4 × 9 hours
    expect(quarterHourly.slots).toEqual([{ hour: 9, minute: 0 }])

    // Exactly at the cap stays fully expanded.
    const atCap = weeklyScheduleSlots("0,30 9-12 * * *", ANY_WEEK)! // 2 × 4 = 8
    expect(atCap.aggregatedCount).toBeUndefined()
    expect(atCap.slots).toHaveLength(MAX_WEEKLY_PILLS_PER_DAY)
  })

  it("returns null for unparseable schedules", () => {
    expect(weeklyScheduleSlots("not a cron", ANY_WEEK)).toBeNull()
    expect(weeklyScheduleSlots("0 8 * *", ANY_WEEK)).toBeNull()
  })

  /* A monthly job used to land a pill on all seven columns: with dow `*` the
   * day set was the full week and the day-of-month field was never read, so the
   * grid claimed a once-a-month job fired daily. Counting the pills over a
   * multi-month sweep is what pins it — asserting "the 1st is in there" passes
   * just as happily when all 31 days are. */
  it("fires a monthly job once a month across the grid, not once a day", () => {
    // Eight consecutive weeks, Mon 2026-08-31 through Sun 2026-10-25: the
    // window holds exactly two firsts-of-month, Tue 2026-09-01 and Thu
    // 2026-10-01.
    const hits: { week: number; day: number }[] = []
    for (let week = 0; week < 8; week++) {
      const w = weeklyScheduleSlots("0 9 1 * *", weekDatesFor(new Date(2026, 7, 31 + week * 7)))!
      expect(w.slots).toEqual([{ hour: 9, minute: 0 }])
      for (const day of w.days) hits.push({ week, day })
    }
    expect(hits).toEqual([
      { week: 0, day: 2 }, // Tue 2026-09-01
      { week: 4, day: 4 }, // Thu 2026-10-01
    ])
  })

  it("keeps a month-restricted job inside its month", () => {
    // `25 10 26 8 *` — 10:25 on 26 August only.
    const inAugust = weeklyScheduleSlots("25 10 26 8 *", weekDatesFor(new Date(2026, 7, 29)))!
    expect(inAugust.days).toEqual([3]) // Wed 2026-08-26
    expect(inAugust.slots).toEqual([{ hour: 10, minute: 25 }])

    // Same day-of-month one month on: the month field must exclude it.
    const inSeptember = weeklyScheduleSlots("25 10 26 8 *", weekDatesFor(new Date(2026, 8, 26)))!
    expect(inSeptember.days).toEqual([])
  })

  it("honours the dom ∪ dow union rule against real dates", () => {
    // `0 9 1 * 1` fires on Mondays OR on the 1st. Mon 2026-08-31 .. Sun
    // 2026-09-06 contains both a Monday (the 31st) and a 1st (Tue 2026-09-01).
    const w = weeklyScheduleSlots("0 9 1 * 1", weekDatesFor(new Date(2026, 8, 2)))!
    expect(w.days).toEqual([1, 2])

    // A week with a Monday but no 1st still fires on the Monday alone.
    const mondayOnly = weeklyScheduleSlots("0 9 1 * 1", weekDatesFor(new Date(2026, 8, 9)))!
    expect(mondayOnly.days).toEqual([1])
  })
})
