---
name: sync
description: Sync the latest conversation with an employee into your context
---

# Sync Skill

## Trigger

This skill activates when the user sends `/sync @employee-name`. It pulls in the most recent conversation with the specified employee so you can respond with full awareness of what was discussed.

## How It Works

You fetch the conversation yourself using the gateway API. No magic injection — you're in control.

**Gateway URL**: Use the gateway URL from the "Current configuration" section of your system prompt (e.g., `http://127.0.0.1:7777`). Do not hardcode it — it may vary.

### Steps

1. **Extract the employee name** from the user's message (e.g., `/sync @jimmy-dev` → `jimmy-dev`)

2. **List all sessions** to find the employee's most recent one:

```bash
curl -s $GATEWAY_URL/api/sessions | jq '[.[] | select(.employee == "EMPLOYEE_NAME")] | sort_by(.lastActivity) | reverse | .[0]'
```

Replace `EMPLOYEE_NAME` with the target and `$GATEWAY_URL` with the gateway URL from your system prompt. This gives you the most recent session for that employee.

**Tip**: Your own session ID is in the "Current session" section of your system prompt. If you want to exclude child sessions of the current session (to avoid circular references), filter with:

```bash
curl -s $GATEWAY_URL/api/sessions | jq '[.[] | select(.employee == "EMPLOYEE_NAME" and .parentSessionId != "YOUR_SESSION_ID")] | sort_by(.lastActivity) | reverse | .[0]'
```

3. **Fetch the full conversation** using the session ID from step 2:

```bash
curl -s $GATEWAY_URL/api/sessions/SESSION_ID | jq '.messages'
```

This returns all messages with `role` and `content` fields. Read through them to understand what was discussed.

4. **Respond naturally** — summarize, highlight key points, offer next steps.

## Your Behavior

After fetching and reading the conversation:

1. **Summarize** the key points — what was discussed, what decisions were made, what work was done
2. **Highlight** any action items, blockers, or open questions
3. **Offer** to take next steps — continue the work, relay instructions, or loop in other employees

## Edge Cases

- **No sessions found**: If no sessions exist for that employee, tell the user: "I don't see any recent conversations with @employee-name."
- **Empty messages**: If the session exists but has no messages, note that the session was created but no conversation happened yet.
- **Employee not found**: If the name doesn't match any sessions, suggest the user check the org with `curl -s $GATEWAY_URL/api/org` to see available employees.
- **Very long conversations**: You decide how much to read. You can fetch the full conversation and focus on the most recent messages, or read everything if it's short. No artificial limits.

## Examples

User: `/sync @jimmy-dev`
You: *[fetches sessions via API, finds jimmy-dev's latest session, reads messages]* "Here's what happened in the latest conversation with @jimmy-dev: [summary]. Want me to follow up on anything?"

User: `/sync @content-writer`
You: *[fetches via API]* "Looking at the recent chat with @content-writer — they finished the blog draft and are waiting for review. Should I ask them to make revisions, or is it ready to publish?"
