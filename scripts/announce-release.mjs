#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { poll } from "./await-npm-version.mjs"

export function slackClient(token) {
  if (!token) throw new Error("SLACK_BOT_TOKEN is required")
  return async (method, fields) => {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(fields), signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`Slack HTTP ${response.status}`)
    const result = await response.json()
    if (!result.ok) throw new Error(`Slack ${method}: ${result.error}`)
    return result
  }
}

async function findAnnouncement({ channel, releaseUrl, oldest, user }, api) {
  let cursor = ""
  do {
    const page = await api("conversations.history", { channel, oldest, cursor, limit: 100 })
    const found = page.messages.find((message) => message.user === user
      && message.text?.match(/https:\/\/[^\s<>|]+/g)?.includes(releaseUrl))
    if (found) return found.ts
    cursor = page.response_metadata?.next_cursor ?? ""
  } while (cursor)
  return false
}

export async function announceRelease({ channel, releaseUrl, oldest, text }, api, options = {}) {
  if (!text.includes(releaseUrl) || !(Number(oldest) > 0)) throw new Error("Require release URL in text and release publication timestamp")
  const auth = await api("auth.test", {})
  const identity = { channel, releaseUrl, oldest, user: auth.user_id }
  const existing = await findAnnouncement(identity, api)
  if (existing) return existing
  try {
    const sent = await api("chat.postMessage", { channel, text, unfurl_links: false })
    return sent.ts
  } catch {
    // A failed response can follow an accepted post. Reconcile history before
    // a later invocation may send again; the lane's mutex serializes callers.
    return poll(() => findAnnouncement(identity, api), {
      timeoutMs: 180000, ...options, label: "Slack announcement receipt",
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [channel, releaseUrl, oldest, textFile] = process.argv.slice(2)
    const ts = await announceRelease({ channel, releaseUrl, oldest, text: readFileSync(textFile, "utf8") }, slackClient(process.env.SLACK_BOT_TOKEN))
    console.log(JSON.stringify({ channel, ts, releaseUrl }))
  } catch (error) {
    console.error(`${error.message}; announcement incomplete, resume after reconciling channel history`)
    process.exitCode = 1
  }
}
