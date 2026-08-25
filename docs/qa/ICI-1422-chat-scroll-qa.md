# ICI-1422 — QA verification pass: chat scroll ownership

Browser verification for the scroll-ownership fix: the stale-chat notice no longer decides
whether the transcript is virtualized, an involuntary re-pin no longer writes over a reader who
has already moved, and a session left at the bottom reopens at the bottom.

The unit and DOM tests in `packages/web` are the contract for criteria 1–5. This pass exists to
confirm the same behaviour in a real browser against a wired `/chat` thread, and — because the
previous pass could not be reproduced — to leave behind a sandbox recipe that runs from a bare
checkout with nothing outside the repository.

---

## How to run this, from a clean checkout

Every earlier chat-scroll QA note pointed at a sandbox helper in the operator's private
workspace, and the hand-typed replacement could not be retyped without hitting a wrong Node,
a foreground `start`, or an inherited `JINN_PORT`. One script now owns the whole sandbox, so
there is nothing to retype:

```sh
pnpm build                      # the script runs the built CLI, not the sources
scripts/verify-chat-scroll.sh   # or: JINN_VERIFY_PORT=8065 scripts/verify-chat-scroll.sh
```

It scrubs the caller's `JINN_*` so an inherited instance cannot aim the run at production,
resolves the Node this checkout's `better-sqlite3` is built for, creates a throwaway home
under `mktemp`, rewrites `gateway.port` in the sandbox's own `config.yaml` and refuses to
start if that resolves to 7777 or 7788, seeds a 220-message transcript, starts the daemon in
the background, waits for it to answer, and prints the URL and a pairing code. It holds the
sandbox until you press Ctrl-C, then stops the daemon and deletes the home on every exit
path. `JINN_VERIFY_HOLD_SECONDS=0` tears down as soon as the sandbox is proven up, which is
the quick way to check the lifecycle itself.

Open the printed `/chat?session=device-scroll-check` URL, enter the pairing code, and set
localStorage `jinn-onboarded` to `true` to skip the first-run wizard. Drive the page with
`agent-browser` on a profile of its own and delete that profile at the end. Do not use
`pnpm dev`: the Vite dev server proxies its API and HMR socket back to the gateway port it is
given, which reaches straight into production.

## The checks

Run each at 1440x900 and 390x844, in light and dark.

| | Check | Pass |
| --- | --- | --- |
| A | Open the URL cold | The transcript is at the bottom, not the top, and the composer is clear. |
| B | Make the stale-chat notice appear and leave (lower `sessions.staleChat.tokenThreshold` in the sandbox config and age the session) | The transcript stays windowed and stays pinned to the bottom through both transitions. |
| C | Send a message from the bottom | The view stays at the bottom. It does not jump away and come back. |
| D | Scroll up a little from the exact bottom | The first drag moves smoothly. Nothing snaps back or stutters at the start. |
| E | With the reader scrolled up, let new content arrive | The reader stays where they put it, and "Jump to latest" appears; pressing it returns to the bottom. |
| F | On 390x844, drag the transcript and release | It slides and settles. It does not stick to the finger or freeze on release. |

F is desktop touch emulation: the events are dispatched but the platform fling physics are
not, so the feel of a real fling stays UNVERIFIED-BY-HAND. What the emulation does cover is
the write gate — that a touch in progress is never overwritten — and the DOM test for the
touch phase covers the same rule.

---

## What was measured

A throwaway gateway on port **7792**, its own home, built from this worktree, seeded with a
130-group transcript and destroyed at the end of the run. Port 7777 was confirmed healthy and
untouched before and after. Geometry was read off the live `.chat-messages-scroll` element.

### Criterion 1 — the notice does not decide windowing

The stale-chat notice is the `footer` prop. It was made to appear by lowering the sandbox's
`sessions.staleChat.tokenThreshold` and ageing the session past `staleAfterMinutes`.

| Footer | `virtualized` | `scrollHeight` | distance from bottom |
| --- | --- | --- | --- |
| absent | `true` | 16706 | 0 |
| present | `true` | 16988 | 0 |

Windowing stays on across the toggle, and the reader stays pinned to the bottom. The footer's
282px changes the content height and nothing else. On `main` the same transcript drops out of
virtualization the moment the notice mounts.

The inner wrapper also keeps the `pb-[var(--space-6)]` branch while virtualized, rather than the
`justify-end` flex branch — the bottom-aligned branch has no room for a total-size spacer, which
is why it is now reserved for the short-transcript case that criterion 2 covers.

### Breakpoints

One smoke capture per breakpoint touched, both with the notice present:

| Viewport | `virtualized` | distance from bottom | Result |
| --- | --- | --- | --- |
| 1440×900 | `true` | 0 | transcript at bottom, notice inline above the composer |
| 390×844 | `true` | 0 | notice stacks, full-width action, composer clear |

The full desktop/mobile × light/dark matrix is the verifier's gate, not this pass.

---

## Not covered here

Criteria 3, 4, and 5 are timing and input-ownership rules — a ResizeObserver racing a reader, a
re-pin landing mid-fling, a stored scroll position on reopen. They are covered by the tests in
`packages/web/src/components/chat/__tests__/` and `packages/web/src/hooks/`, each of which fails
on `main` at `50f065e4`. Reproducing a momentum fling or a background-tab return by hand in a
sandbox is less reliable than the unit coverage, not more, so it was not attempted.
