---
name: request-human-help
description: Use when an agent is blocked by something only a human can clear — captcha, login, 2FA, a native macOS dialog, or anything requiring a person to look at or touch the screen. Posts an assist request to the Jinn chat (with an optional [Take control] screen-share), pings Slack #work-items, then blocks by polling until a human resolves it or ~10 min passes.
---

# Request Human Help

When you cannot proceed without a human (captcha / login / 2FA / native dialog):

## 0. Find your own session ID

Read it from your context: the **"## Current session"** section contains a line
`- Session ID: <uuid>`. That uuid is `SID` below. Every session — COO and spawned
employee child alike — has this line injected (it's an always-included, never-trimmed
context section). If for some reason it's absent, fall back to the newest non-idle
session: `curl -s http://0.0.0.0:7777/api/sessions | jq -r '.[0].id'` — but the
context line is authoritative; prefer it.

## 1. Fire the request

```bash
SID="<the Session ID from your Current session context section>"
REASON="Cloudflare captcha on checkout page"
URL="https://example.com/checkout"   # optional, the page that needs eyes
RESP=$(curl -s -X POST "http://0.0.0.0:7777/api/sessions/$SID/assist/request" \
  -H 'Content-Type: application/json' \
  -d "{\"reason\":$(printf '%s' "$REASON" | jq -Rs .),\"url\":$(printf '%s' "$URL" | jq -Rs .)}")
REQ=$(printf '%s' "$RESP" | jq -r .reqId)
echo "assist reqId=$REQ"
```

The server already persisted a chat card and pinged Slack. (If `#work-items`
doesn't exist, that's fine — the card in chat is the primary signal.)

## 2. Block by polling (4s interval, ~10 min cap)

```bash
for i in $(seq 1 150); do
  ST=$(curl -s "http://0.0.0.0:7777/api/assist/$REQ" | jq -r .status)
  if [ "$ST" = "resolved" ]; then echo "RESOLVED"; break; fi
  if [ "$ST" = "timed_out" ]; then echo "TIMED_OUT"; break; fi
  sleep 4
done
```

## 3. Return

- **resolved** → "Human resolved the block. Re-check the page state and continue."
- **timed_out** / loop exhausted → mark it: `curl -s -X POST "http://0.0.0.0:7777/api/assist/$REQ/resolve" >/dev/null` is NOT what you want for timeout; instead the card stays as `timed_out` server-side once the cap passes. Report: "No human responded within ~10 min. Reporting the blocker and stopping this attempt."

Never busy-wait faster than 4s. Never exceed ~10 min. Do not SSH or try to
click the native dialog yourself — that's exactly what the human is for.
