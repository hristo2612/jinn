/**
 * Cron schedule parsing and human-readable description utilities.
 * No external dependencies — covers the common patterns used in Jimmy cron jobs.
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

/**
 * Parse a 5-field cron expression into schedule slots for weekly grid display.
 * Returns { hour, minute, days } where days is 0=Sun..6=Sat.
 * Returns null for unparseable expressions.
 */
export function parseScheduleSlots(
  schedule: string
): { hour: number; minute: number; days: number[] } | null {
  if (!schedule || !schedule.trim()) return null
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [min, hour, , , dow] = parts
  const minNum = parseInt(min, 10)
  const hourNum = parseInt(hour, 10)
  if (isNaN(minNum) || isNaN(hourNum)) return null

  let days: number[]

  if (dow === '*') {
    days = [0, 1, 2, 3, 4, 5, 6]
  } else if (dow === '1-5') {
    days = [1, 2, 3, 4, 5]
  } else if (dow === '0-6' || dow === '0,1,2,3,4,5,6') {
    days = [0, 1, 2, 3, 4, 5, 6]
  } else if (dow.includes(',')) {
    days = dow.split(',').map(Number).filter(n => !isNaN(n) && n >= 0 && n <= 6)
    if (days.length === 0) return null
  } else {
    const dowNum = parseInt(dow, 10)
    if (isNaN(dowNum) || dowNum < 0 || dowNum > 6) return null
    days = [dowNum]
  }

  return { hour: hourNum, minute: minNum, days }
}

/**
 * Convert a 5-field cron expression to a human-readable description.
 * Falls back to the raw expression for anything unparseable.
 */
export function describeCron(schedule: string): string {
  if (!schedule || !schedule.trim()) return ''

  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return schedule

  const [min, hour, dom, , dow] = parts

  // Every minute: * * * * *
  if (min === '*' && hour === '*' && dom === '*' && dow === '*') {
    return 'Every minute'
  }

  // Every N minutes: */5 * * * *
  if (min.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    const interval = parseInt(min.slice(2), 10)
    if (!isNaN(interval)) {
      return `Every ${interval} minutes`
    }
  }

  // Every hour: 0 * * * *
  if (min !== '*' && hour === '*' && dom === '*' && dow === '*') {
    return 'Every hour'
  }

  const hourNum = parseInt(hour, 10)
  const minNum = parseInt(min, 10)
  if (isNaN(hourNum) || isNaN(minNum)) return schedule

  const time = minNum === 0 ? formatTime(hourNum, minNum) : formatTimeWithMinute(hourNum, minNum)

  // Every N days: 0 12 */2 * *
  if (dom.startsWith('*/') && dow === '*') {
    const interval = parseInt(dom.slice(2), 10)
    if (!isNaN(interval)) {
      return `Every ${interval} days at ${time}`
    }
  }

  // Monthly: 0 8 1 * *
  if (dom !== '*' && dow === '*') {
    const dayNum = parseInt(dom, 10)
    if (!isNaN(dayNum)) {
      const suffix = dayNum === 1 ? 'st' : dayNum === 2 ? 'nd' : dayNum === 3 ? 'rd' : 'th'
      return `Monthly on the ${dayNum}${suffix} at ${time}`
    }
  }

  // Weekdays: 0 10 * * 1-5
  if (dom === '*' && dow === '1-5') {
    return `Weekdays at ${time}`
  }

  // Specific day of week: 0 6 * * 1
  if (dom === '*') {
    const dowNum = parseInt(dow, 10)
    if (!isNaN(dowNum) && dowNum >= 0 && dowNum <= 6) {
      return `${DAY_NAMES[dowNum]} at ${time}`
    }
  }

  // Daily: 0 8 * * *
  if (dom === '*' && dow === '*') {
    return `Daily at ${time}`
  }

  return schedule
}
