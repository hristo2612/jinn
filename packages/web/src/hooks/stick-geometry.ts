/**
 * Where the reader is relative to the bottom of a transcript, as arithmetic.
 *
 * Separate from the hook that acts on it because these are the only parts of
 * stick-to-bottom with no DOM, no React and no state — the answers everything
 * else in the transcript's scroll behaviour is phrased in terms of.
 */

/** Within this many px of the bottom counts as "at bottom" (engage follow). */
export const STICK_THRESHOLD_PX = 56

type Metrics = { scrollHeight: number; scrollTop: number; clientHeight: number }

/** Distance in px from the current scroll position to the very bottom (0 = pinned). */
export function distanceFromBottom(el: Metrics): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

/** Whether auto-follow should be engaged for a given distance from the bottom. */
export function shouldFollow(distance: number, threshold: number = STICK_THRESHOLD_PX): boolean {
  return distance <= threshold
}

/**
 * Whether auto-follow is engaged after a scroll event that moved the position.
 *
 * Re-engaging takes a move TOWARD the bottom: an event that changes the position
 * without changing the gap is compensation — a fold anchoring, the browser
 * clamping a shrink — and compensation carries no intent to follow.
 */
export function followAfterScroll(dist: number, prevDist: number, following: boolean, threshold: number): boolean {
  if (dist > prevDist) return false
  if (dist < prevDist) return shouldFollow(dist, threshold)
  return following
}

/** New messages accumulated while detached (current count − count when last caught up), ≥ 0. */
export function unreadDelta(currentCount: number, seenCount: number): number {
  return Math.max(0, currentCount - seenCount)
}
