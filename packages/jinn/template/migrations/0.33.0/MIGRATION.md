# Instance migration bundle: 0.32.0 → 0.33.0

<!-- BEGIN RELEASE RATIONALE -->
This release bundle was generated from the exact instance-template delta.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.

## `CLAUDE.md`

- Operation: `modify`
- Base payload: `files/base/CLAUDE.md`
- Target payload: `files/target/CLAUDE.md`
- Merge instruction: compare the audited materialized base with the current instance path `CLAUDE.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/connectors.md`

- Operation: `modify`
- Base payload: `files/base/docs/connectors.md`
- Target payload: `files/target/docs/connectors.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/connectors.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/self-modification.md`

- Operation: `modify`
- Base payload: `files/base/docs/self-modification.md`
- Target payload: `files/target/docs/self-modification.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/self-modification.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/skills.md`

- Operation: `modify`
- Base payload: `files/base/docs/skills.md`
- Target payload: `files/target/docs/skills.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/skills.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/migrate/SKILL.md`

- Operation: `remove`
- Base payload: `files/base/skills/migrate/SKILL.md`
- Target payload: none (file is removed from stock)
- Merge instruction: compare the audited materialized base with the current instance path `skills/migrate/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.
