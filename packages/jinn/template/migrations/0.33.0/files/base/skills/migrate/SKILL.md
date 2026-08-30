---
name: migrate
description: Safely merge validated package migration bundles into this {{portalName}} instance after an upgrade
---

# Migrate Skill

## Trigger

Use this skill when the automatic upgrade handoff opens a COO session, when the
user runs `/migrate`, or when asked to update the instance after a package
upgrade.

## Safety model

The installed package is read-only. The instance is user-owned and divergent:
custom doctrine, config, skills, org, and docs always take precedence over
stock defaults. The explicit COO handoff may conservatively merge only the
selected instance after a verified snapshot exists.

The gateway automatically discovers validated, versioned manifest bundles and
composes one canonical prompt. `jinn migrate` remains a compatibility prompt
dispenser for the same service; it is not required for discovery. `--apply` is
deprecated and never advances the marker on engine exit.

## Required procedure

1. Verify the idempotent snapshot named by the prompt before editing anything.
2. For every manifest record, perform a three-way comparison:
   - read-only materialized base payload from the snapshot,
   - current customized user file,
   - read-only materialized target payload from the snapshot.
3. Preserve user customizations. A user edit wins over a stock default.
4. Never delete user content without an explicit instruction and backup.
5. Work only inside the selected instance. Never edit the installed package.
6. Record each path as reviewed or explicitly skipped/conflicted.
7. Verify the bundle postconditions and report changed, preserved, skipped,
   and conflicted paths.

The package bundle remains generic. The snapshot materializes both base and
target with the exact `portalName` and `portalSlug` derived from the selected
instance config, and records the replacement inputs and hashes in
`materialization.json`. Compare only those audited snapshot payloads with the
user file. Never compare a personalized user file to the raw generic payload,
never reverse arbitrary user text into placeholders, and never copy raw
double-brace template placeholders into an existing instance. An unresolved
placeholder newly introduced by the target, or present in a customized user
file, is a conflict: preserve the user file and report it instead of guessing.
An unresolved placeholder already present in both base and target may be
carried only when the current user file equals the materialized base
byte-for-byte.

For Markdown, merge by headings and append only genuinely new stock sections.
For YAML, add missing keys without overwriting existing values or formatting.
For skills and docs, replace an unchanged stock file with the target payload;
merge a customized file cautiously. Create the normal `.claude/skills` and
`.agents/skills` symlinks for a new skill. A removed stock path is deleted only
when the user copy still equals the old base payload.

## Completion receipt and marker

After all records are verified, write
`.migration-snapshots/<migrationKey>/completion-receipt.json`:

```json
{
  "schemaVersion": 1,
  "migrationKey": "<key from prompt>",
  "reviewedFiles": ["each safely reviewed path"],
  "skippedItems": [{ "path": "a conflicted path", "reason": "why" }],
  "verifiedAt": "<ISO timestamp>"
}
```

Every manifest path must appear in `reviewedFiles` or `skippedItems`. Only then
run the exact key-gated command from the prompt:

```bash
jinn migrate --mark-done <version> --migration-key <migrationKey>
```

Never edit `jinn.version` manually. A failed or interrupted session, or a
successful engine exit by itself, must leave the marker and reminder intact.

If a merge cannot be resolved safely, stop, record the path in `skippedItems`,
leave the marker unchanged, and ask for direction. A preview request performs
no writes and summarizes the manifest records only.
