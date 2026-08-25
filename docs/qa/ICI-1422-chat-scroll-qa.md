# ICI-1422 — QA verification pass: chat scroll ownership

Browser verification for the scroll-ownership fix: the stale-chat notice no longer decides
whether the transcript is virtualized, an involuntary re-pin no longer writes over a reader who
has already moved, and a session left at the bottom reopens at the bottom.

The unit and DOM tests in `packages/web` are the contract for criteria 1–5. This pass exists to
confirm the same behaviour in a real browser against a wired `/chat` thread, and — because the
previous pass could not be reproduced — to leave behind a sandbox recipe that runs from a bare
checkout with nothing outside the repository.

---

## How to reproduce this, from a clean checkout

Every earlier chat-scroll QA note pointed at a sandbox helper that lives in the operator's
private `~/.jinn` workspace. That path is unavailable to anyone else, so the run could not be
repeated. The steps below use only files in this repository.

```sh
REPO=$(git rev-parse --show-toplevel)
SBX=/tmp/jinn-sandbox-ici1422        # basename matches `pnpm reap`'s throwaway pattern
PORT=7793                            # never 7777 (production), never 7788 (operator demo)

cd "$REPO" && pnpm install && pnpm build

# 1. Isolated home. </dev/null keeps setup non-interactive; it only prompts on a TTY.
JINN_HOME="$SBX" JINN_NO_OPEN=1 node packages/jinn/dist/bin/jinn.js setup </dev/null
```

**Rewrite the port in the file before starting anything.** A fresh home ships
`gateway.port: 7777`, and the start/stop lifecycle kills whatever owns the *configured* port —
passing `-p` alone is not enough to keep production safe. In `$SBX/config.yaml` set
`gateway.port: 7793` and `gateway.authRequired: false`, then confirm it:

```sh
grep -nE '^\s+(port|host|authRequired):' "$SBX/config.yaml"   # must show 7793, not 7777

# 2. Seed the long transcript (220 messages ≈ 220 groups, well past VIRTUALIZE_THRESHOLD = 50).
#    The gateway must NOT be running: the fixture opens the sqlite file directly.
pnpm exec node scripts/device-scroll-fixture.mjs --home "$SBX"
```

The fixture is built for testing fling physics on a real phone, so it rewrites `gateway.host`
to `0.0.0.0`, and a non-loopback bind always forces auth on. For a loopback-only review, set
`gateway.host: "127.0.0.1"` back afterwards.

```sh
# 3. Start, then pair the browser (device trust is a separate gate from authRequired).
JINN_HOME="$SBX" JINN_NO_OPEN=1 node packages/jinn/dist/bin/jinn.js start -p "$PORT"
JINN_HOME="$SBX" node packages/jinn/dist/bin/jinn.js pair    # prints a single-use code

# 4. Open http://127.0.0.1:7793/chat?session=device-scroll-check and enter the code.
#    localStorage `jinn-onboarded = true` skips the first-run wizard on a fresh home.

# 5. Teardown — pass or fail.
JINN_HOME="$SBX" node packages/jinn/dist/bin/jinn.js stop -p "$PORT"
rm -rf "$SBX"
```

Drive the page with `agent-browser` on a profile of its own, and delete that profile at the end.
Do not use `pnpm dev`: the Vite dev server proxies its API and HMR socket back to the gateway
port it is given, which reaches straight into production.

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
