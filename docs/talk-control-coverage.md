# Talk control coverage

> Generated from `APP_ROUTES` and `TALK_SURFACE_COVERAGE`. Edit the typed inventory, not this table.

| Route | Path | Context | Evidence and controls |
| --- | --- | --- | --- |
| chat | `/` | semantic | selected session and transcript; controls: open, message, continue, stop |
| chat-redirect | `/chat/:sessionId?` | semantic | redirect destination; controls: navigate |
| cron-list | `/cron` | semantic | jobs, filters, and run summaries; controls: filter, open, trigger |
| cron-detail | `/cron/:id` | semantic | selected job and run history; controls: edit, enable, disable, trigger |
| todos-index | `/todos` | semantic | board redirect; controls: navigate |
| todo-board | `/todos/b/:board` | semantic | board, filters, and visible Todos; controls: filter, open, create |
| todo-detail | `/todos/:todoId` | semantic | selected Todo, status, relations, comments, and runs; controls: edit, comment, assign, delegate, state |
| notes-list | `/notes` | semantic | note list and search; controls: open, create |
| notes | `/notes/*` | semantic | selected note and folder; controls: open, create, update |
| experiments-list | `/experiments` | semantic | experiment filters and summaries; controls: open, create |
| experiment-detail | `/experiments/:id` | semantic | selected hypothesis, metrics, readings, and verdict; controls: record, conclude, reopen |
| kanban-redirect | `/kanban` | semantic | redirect destination; controls: navigate |
| logs | `/logs` | semantic | bounded redacted activity summary; controls: refresh |
| limits | `/limits` | semantic | engine limit windows and freshness; controls: refresh |
| org | `/org` | semantic | employee, reporting line, and activity; controls: open, delegate |
| constellation | `/constellation` | semantic | visible company graph, active lens, and selected entity; controls: filter, open |
| settings-plugins | `/settings/plugins` | semantic | plugin inventory and state; controls: enable, disable, rescan |
| settings | `/settings` | semantic | active settings and safe configuration summary; controls: update |
| skills-list | `/skills` | semantic | installed skill summaries; controls: open |
| skill-detail | `/skills/:name` | semantic | selected skill metadata and content; controls: update |
| file | `/file` | semantic | published file metadata and preview; controls: open, attach |
| more | `/more` | semantic | available destinations; controls: navigate |
| workflow-list | `/workflow` | semantic | workflow definitions and status; controls: open, start |
| workflow-detail | `/workflow/:id` | semantic | definition, revision, graph, and runs; controls: edit, start, enable, disable |
| workflow-run | `/workflow/:id/runs/:runId` | semantic | selected run, node, attempts, gates, and output; controls: cancel, input, decide |
| talk-orb | `/talk-orb` | semantic | development orb bench state; controls: none |
| redesign | `/redesign` | semantic | development-only design bench; controls: none |
| plugin-contributed | `/*` | explicit gap | plugin-context-unavailable; plugin host SDK publishes route, selected object, controls, and freshness |

A normal question uses semantic context. One bounded image is permitted only when the current surface declares a named visual gap; the Talk orb, hidden content, secrets, and password inputs are excluded.

## Company capability inventory

> Generated from `TALK_COMPANY_CAPABILITY_COVERAGE`. A semantic route never implies mutation authority.

| Capability | Status | Manifest operations | Verification or planned seam |
| --- | --- | --- | --- |
| todo-core | supported | read_todo, talk_create_todo, talk_edit_todo, talk_set_todo_status, talk_comment_todo, talk_assign_todo, talk_delegate_todo | authoritative Todo, creation, status, comment, assignment, and linked-session rereads |
| todo-extended | explicit gap | — | todo-extended-command-adapter-missing; reuse label, relation, attachment, and comment-delete commands; cancellation stays off the voice surface deliberately |
| chat-core | supported | read_session, talk_search_chat_messages, talk_draft_reply, talk_replace_draft, talk_send_draft, talk_draft_and_send, talk_send_to_session | bounded current-chat excerpts, visible-composer receipts, and a durable named-session message re-read bound to the operator's own utterance |
| chat-lifecycle | explicit gap | — | chat-lifecycle-command-adapter-missing; reuse create, rename, archive, duplicate, delete, queue, stop, and reset commands |
| delegation | supported | talk_delegate_todo | Todo-to-session link, child session, and dispatch rereads |
| workflow-core | supported | talk_start_workflow_run, read_workflow_runs, read_workflow_run | workflow-run repository rereads |
| workflow-authoring-and-gates | explicit gap | — | workflow-command-adapter-missing; reuse definition edits, run cancellation, input gates, and workflow approval commands |
| voice-approval | supported | prepare_voice_approval, commit_voice_approval | operator-bound challenge, provider transcript identity, target revision, and durable decision audit |
| topic-memory | supported | talk_recall_topic, talk_remember_topic | durable topic commitments, candidates, navigation, and source rehydration |
| screen-navigation-and-visual | supported | open_todos, open_todo, open_chats, open_workflows, focus_element, resolve_and_open, capture_current_view | browser receipt, awaited UI effect, or bounded sanitized visual receipt |
| capability-inventory | supported | read_talk_capability | typed manifest-backed supported operation or exact gap id and planned adapter |
| notes | explicit gap | — | notes-command-adapter-missing; reuse managed note list, read, create, and update commands |
| experiments | explicit gap | — | experiments-command-adapter-missing; reuse experiment create, reading, conclude, and reopen commands |
| cron | explicit gap | — | cron-command-adapter-missing; reuse cron update, enable, disable, trigger, and run-inspection commands |
| org | explicit gap | — | org-command-adapter-missing; reuse employee read, editable-field update, delegation, and session commands |
| skills | explicit gap | — | skills-command-adapter-missing; reuse managed skill read and update commands with exact content confirmation |
| settings-and-plugins | explicit gap | — | settings-plugins-command-adapter-missing; reuse safe config and guarded plugin lifecycle commands without exposing secrets |
| logs-and-limits | explicit gap | — | logs-limits-command-adapter-missing; reuse bounded redacted log queries and engine-limit refresh commands |
| managed-files | explicit gap | — | managed-files-command-adapter-missing; reuse allowed-home list, read, publish, and attach commands |
| instances-and-onboarding | explicit gap | — | instance-onboarding-command-adapter-missing; reuse guarded instance and onboarding commands with exact scope confirmation |
| company-read-lanes | explicit gap | — | company-read-lanes-adapter-missing; reuse knowledge, search, cost, connector, heartbeat, and managed approval reads |

## Reading this report

Route coverage and company-control coverage are separate guarantees. A supported
route means Talk can describe the rendered state through typed semantic context;
it does not grant a write. A supported company capability names the exact
versioned manifest operations and the authoritative reread used to verify them.
Every other lane has a stable gap id and the canonical command seam required to
close it, so the provider must state the limitation instead of fabricating
success.

Gateway writes require the authenticated operator. Provider ids supply replay
identity only; they do not supply authority. Exact retries return a durable
receipt, changed arguments conflict, and browser UI effects run only after the
gateway has verified the real store. Park/reload rebuilds the runtime from
SQLite while preserving the ordinary searchable Talk chat and topic anchors.

The sole image lane is `capture_current_view`. It is available only for a named
visual gap on a partial semantic context, once per final operator utterance and
context revision. Its sanitized image excludes Aurora, hidden/secret/password
content, is capped at 1280x1280 and 180 KB, and is never persisted. The normal
turn record retains only bytes, dimensions, estimated image tokens, latency,
reason, request identity, and context revision. All other costs flow through the
existing normal session ledger; an unknown realtime price is marked
`pricingKnown: false` rather than presented as free.
