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

/**
 * Where to reopen a transcript the reader is leaving, or `undefined` for the bottom.
 *
 * A reader who left at the bottom left no position behind. The pixel recorded
 * there is the bottom of the transcript AS IT WAS, and reopening on it once the
 * transcript has grown — or re-measured itself on the way in — lands short of the
 * bottom they expect. Only a genuine scrolled-up position is worth keeping.
 */
export function scrollTopToRemember(el: Metrics, threshold: number = STICK_THRESHOLD_PX): number | undefined {
  return shouldFollow(distanceFromBottom(el), threshold) ? undefined : el.scrollTop
}

/** Record that position on a session, or forget a stored one if they left at the bottom. */
export function rememberScrollTop(store: Map<string, number>, sessionId: string, el: Metrics): void {
  const top = scrollTopToRemember(el)
  if (top === undefined) store.delete(sessionId)
  else store.set(sessionId, top)
}

/**
 * Record the position of a session the reader is leaving, from whichever scroller is on
 * screen. A pane that is display-toggled away — every pane but one, on a phone — is still
 * in the DOM and reports clientHeight 0 and scrollTop 0, and storing that would move the
 * reader to the top of a thread they left in the middle. No session means nothing to
 * record against.
 */
export function rememberVisibleScrollTop(
  store: Map<string, number>,
  sessionId: string | null | undefined,
  scroller: HTMLElement | null,
): void {
  if (!sessionId || !scroller?.clientHeight) return
  rememberScrollTop(store, sessionId, scroller)
}

/** New messages accumulated while detached (current count − count when last caught up), ≥ 0. */
export function unreadDelta(currentCount: number, seenCount: number): number {
  return Math.max(0, currentCount - seenCount)
}
