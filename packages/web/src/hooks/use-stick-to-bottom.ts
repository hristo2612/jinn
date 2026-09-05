import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranscriptOpen } from '@/components/chat/transcript-open'
import { distanceFromBottom, followAfterScroll, shouldFollow, STICK_THRESHOLD_PX, unreadDelta } from './stick-geometry'

/**
 * Stick-to-bottom for the chat thread.
 *
 * One source of truth — `followRef` — decides whether the view auto-follows new
 * content, and only the user's own scroll flips it: any `scroll` event that moves
 * further from the bottom means "I scrolled up to read", however slightly, and
 * coming back within the threshold means "I caught up". Detaching on movement
 * rather than on the threshold matters because a freshly opened transcript resizes
 * for a second or two, and each re-pin below would otherwise undo a small scroll-up
 * before the user ever cleared the band. Programmatic scrolls never flip it. The
 * jump arrow is a SECOND decision over the same event: it is gated on the gap
 * alone, since an arrow offering to scroll the reader four pixels is noise.
 *
 * Following is performed synchronously in a layout effect (before paint) keyed on
 * the growing content, so streaming can never visually detach. Resize / mobile
 * keyboard (ResizeObserver on the *viewport*) and tab return (visibilitychange /
 * pageshow) each re-pin when — and only when — we're following. When NOT following
 * we never touch scrollTop, so the browser's native `overflow-anchor` holds the
 * read position through image/content reflow above. Opening a transcript — one
 * target chosen before paint, then a bounded settle window — is transcript-open.ts.
 *
 * Replaces the old IntersectionObserver(position) + ResizeObserver(content)→rAF
 * design, whose two async mechanisms raced and lost the stream (the sentinel left
 * the 80px band before the queued rAF read the now-stale "at bottom" flag).
 */

export interface UseStickToBottomOptions {
  /** Changes whenever the in-flight assistant message streams more text. */
  streamingText?: string
  /** Total committed message count — drives the open, growth-follow and unread count. */
  messageCount: number
  /** Identity of the newest committed message. When the count grows but this key
   *  does not change, history was prepended above the viewport, not appended as
   *  unread content below it. */
  latestMessageKey?: string | null
  /** Override the at-bottom threshold (px). */
  threshold?: number
  /** Replaces every scroll-to-bottom this hook makes. A virtualised transcript's
   *  true bottom is only known once the last row has measured, so it scrolls
   *  through the virtualizer, which resolves it to the scroller's own maximum. */
  scrollToEnd?: (behavior: ScrollBehavior) => void
  /** Takes where the transcript's own last scroll write left the scroller, when
   *  something other than this hook also writes to it — see the virtualizer's
   *  `takeTranscriptWriteTop`. */
  takeLastWriteTop?: () => number | undefined
  /** Where the reader left this transcript. Opens there instead of at the bottom. */
  initialScrollTop?: number
  /** Total content height, when the transcript knows it better than `scrollHeight`. */
  contentSize?: () => number
}

export interface StickToBottom {
  /** Callback ref for the scroll container. Using a callback (not a ref object) so the
   *  listener effects re-run when the element actually mounts — the scroller appears in
   *  a later render than the hook (the empty-state branch renders first). */
  containerRef: (node: HTMLDivElement | null) => void
  /** Show the "jump to latest" affordance (user has scrolled away from the bottom). */
  showJump: boolean
  /** New messages that arrived while detached (0 when caught up). */
  unreadCount: number
  /** Scroll to the bottom and re-engage follow. Defaults to smooth (for the button). */
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

export function useStickToBottom({
  streamingText,
  messageCount,
  latestMessageKey,
  threshold = STICK_THRESHOLD_PX,
  scrollToEnd,
  takeLastWriteTop,
  initialScrollTop,
  contentSize,
}: UseStickToBottomOptions): StickToBottom {
  // The scroll container, tracked as state (via a callback ref) so the listener
  // effects re-run when it mounts, plus a ref mirror for imperative reads.
  const elRef = useRef<HTMLDivElement | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    elRef.current = node
    setEl(node)
  }, [])

  const followRef = useRef(true)
  // True only while a programmatic SMOOTH scroll is animating, so its intermediate
  // (far-from-bottom) scroll events aren't mistaken for the user scrolling up.
  const animatingRef = useRef(false)
  // Distance from the bottom at the previous scroll event — the baseline for
  // "did this event move away from the bottom?".
  const prevDistRef = useRef(0)
  // Scroll position at the previous scroll event. A scroll event that leaves it
  // where it was carries no user intent — see the listener below.
  const prevTopRef = useRef(0)
  // Fresh override for stable callbacks (avoids stale closures).
  const scrollToEndRef = useRef(scrollToEnd)
  scrollToEndRef.current = scrollToEnd
  const takeLastWriteTopRef = useRef(takeLastWriteTop)
  takeLastWriteTopRef.current = takeLastWriteTop
  // Count at the moment we were last caught up — the baseline for unreadDelta.
  const seenCountRef = useRef(messageCount)
  // Fresh message count for stable callbacks (avoids stale closures).
  const messageCountRef = useRef(messageCount)
  messageCountRef.current = messageCount
  const latestKey = latestMessageKey ?? `count:${messageCount}`
  const prevCountRef = useRef(messageCount)
  const prevLatestKeyRef = useRef(latestKey)
  const uiRaf = useRef<number | null>(null)

  const [showJump, setShowJump] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)

  const pinNow = useCallback((node: HTMLDivElement) => {
    node.scrollTop = node.scrollHeight
    prevTopRef.current = node.scrollTop
  }, [])

  // The bottom, reached the way this transcript can reach it: through the
  // virtualizer when it has one, because `scrollHeight` there is the estimate
  // it is currently painting and the last row has not measured yet.
  const pinToEnd = useCallback((node: HTMLDivElement) => {
    const toEnd = scrollToEndRef.current
    if (!toEnd) { pinNow(node); return }
    toEnd('auto')
    prevTopRef.current = node.scrollTop
  }, [pinNow])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = elRef.current
    if (!node) return
    followRef.current = true
    seenCountRef.current = messageCountRef.current
    setShowJump(false)
    setUnreadCount(0)
    const toEnd = scrollToEndRef.current
    if (toEnd) {
      animatingRef.current = behavior === 'smooth'
      toEnd(behavior)
    } else if (behavior === 'smooth' && typeof node.scrollTo === 'function') {
      animatingRef.current = true
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    } else {
      pinNow(node)
    }
  }, [pinNow])

  // ── Initial load / session switch (ChatPane is keyed → this hook remounts). ──
  useTranscriptOpen({
    node: el,
    ready: messageCount > 0,
    initialScrollTop,
    scrollToBottom: pinToEnd,
    contentSize: (node) => contentSize?.() ?? node.scrollHeight,
    isPinned: () => followRef.current,
    onOpened: (node) => {
      const dist = distanceFromBottom(node)
      followRef.current = shouldFollow(dist, threshold)
      seenCountRef.current = messageCountRef.current
      prevTopRef.current = node.scrollTop
      prevDistRef.current = dist
    },
  })

  // ── User-intent tracking: the scroll event is the ONLY place follow flips. ──
  // Keyed on `el` so it (re)attaches when the scroller mounts in a later render.
  useEffect(() => {
    if (!el) return
    prevTopRef.current = el.scrollTop

    const onScroll = () => {
      const dist = distanceFromBottom(el)
      const top = el.scrollTop
      const written = takeLastWriteTopRef.current?.()
      // A scroll event reporting the position a write already left the scroller at
      // cannot be the user: it is the content re-measuring underneath them, which
      // on the virtualised path happens whenever a row off-window resolves its real
      // height — sometimes moving the position to hold that row still. Take the new
      // distance as the baseline and decide nothing.
      if (top === prevTopRef.current || top === written) {
        prevTopRef.current = top
        prevDistRef.current = dist
        return
      }
      prevTopRef.current = top
      // Distance, not scrollTop direction: when content above shrinks the browser
      // clamps scrollTop down while we are still at the bottom, and a direction
      // check would detach a live stream there.
      const prevDist = prevDistRef.current
      const movedAway = dist > prevDist
      prevDistRef.current = dist
      if (animatingRef.current) {
        // Our own smooth scroll only ever closes the gap to the bottom. Reaching
        // it ends the animation; an event that widens the gap cannot be ours, so
        // the suppression stops there and the event is handled normally. Without
        // that second exit the flag latched whenever the animation was outrun by
        // growing content, and every later scroll the user made was swallowed.
        if (dist <= threshold || !movedAway) {
          if (dist <= threshold) animatingRef.current = false
          return
        }
        animatingRef.current = false
      }
      const follow = followAfterScroll(dist, prevDist, followRef.current, threshold)
      // The arrow is gated on the gap alone — see the note at the top of the file.
      const showArrow = !shouldFollow(dist, threshold)
      followRef.current = follow
      if (follow) seenCountRef.current = messageCountRef.current
      if (uiRaf.current != null) cancelAnimationFrame(uiRaf.current)
      uiRaf.current = requestAnimationFrame(() => {
        uiRaf.current = null
        setShowJump(showArrow)
        setUnreadCount(follow ? 0 : unreadDelta(messageCountRef.current, seenCountRef.current))
      })
    }

    // A manual wheel/touch interrupts an in-flight smooth scroll → respect the user.
    const onUserInput = () => { animatingRef.current = false }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onUserInput, { passive: true })
    el.addEventListener('touchstart', onUserInput, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onUserInput)
      el.removeEventListener('touchstart', onUserInput)
      if (uiRaf.current != null) cancelAnimationFrame(uiRaf.current)
    }
  }, [el, threshold])

  // ── Follow on growth — synchronous, before paint, so streaming never detaches. ──
  useLayoutEffect(() => {
    const node = elRef.current
    if (!node) return
    const prevCount = prevCountRef.current
    const prevLatestKey = prevLatestKeyRef.current
    const prependedHistory = messageCount > prevCount && latestKey === prevLatestKey
    if (prependedHistory) {
      seenCountRef.current += messageCount - prevCount
    }
    if (followRef.current) {
      pinToEnd(node)
      seenCountRef.current = messageCount
      if (unreadCount !== 0) setUnreadCount(0)
    } else {
      setUnreadCount(unreadDelta(messageCount, seenCountRef.current))
    }
    prevCountRef.current = messageCount
    prevLatestKeyRef.current = latestKey
  }, [el, streamingText, messageCount, latestKey, pinToEnd])

  // ── Viewport resize / mobile keyboard: re-pin when following (RO on the container). ──
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current && elRef.current) pinNow(elRef.current)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, pinNow])

  // ── Rendered content growth: image/media decode can change scrollHeight without
  // changing messageCount or streamingText. Keep following users truly pinned.
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const content = el.firstElementChild
    if (!(content instanceof Element)) return
    const ro = new ResizeObserver(() => {
      if (followRef.current && elRef.current) pinToEnd(elRef.current)
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [el, pinToEnd])

  // ── Tab return: re-sync (rAF is throttled in background tabs, so don't rely on it). ──
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === 'visible' && followRef.current && elRef.current) {
        pinNow(elRef.current)
      }
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('pageshow', resync)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('pageshow', resync)
    }
  }, [pinNow])

  return { containerRef, showJump, unreadCount, scrollToBottom }
}
