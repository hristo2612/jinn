import { touchScrollLive } from '@/components/chat/touch-scroll-phase'

/**
 * A re-pin nobody asked for — resize, tab return. A finger or its leftover
 * glide outranks it: assigning `scrollTop` mid-fling ends WebKit's momentum,
 * which is the list going sticky instead of sliding. When `lastWriteTop` is
 * passed, a reader who already moved off that write also outranks it — rows
 * mounting as they drag up resize in the same frame, before scroll detaches
 * follow. A deliberate `scrollToBottom` never comes through here.
 */
export function involuntaryRepin(
  node: HTMLDivElement | null,
  following: boolean,
  pin: (node: HTMLDivElement) => void,
  lastWriteTop?: number,
): void {
  if (!node || !following || touchScrollLive(node)) return
  if (lastWriteTop !== undefined && node.scrollTop !== lastWriteTop) return
  pin(node)
}
