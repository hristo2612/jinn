# Self-Modification

{{portalName}}'s engines operate within `~/.jinn/` and can modify any file in that directory. This enables {{portalName}} to update its own configuration, create skills, manage cron jobs, and restructure the organization at runtime.

## What {{portalName}} Can Edit

| File/Directory | Effect of Modification |
|---|---|
| `config.yaml` | File watcher triggers full config reload |
| `cron/jobs.json` | File watcher triggers cron reschedule |
| `org/**/*.yaml` | File watcher triggers employee registry rebuild |
| `skills/*/SKILL.md` | Read on demand by engines; no watcher needed |
| `skills/**/*` | Supporting skill data; read on demand |

## File Watcher Reactions

The gateway uses chokidar to watch for changes:

- **config.yaml** → Parse YAML, validate schema, reload gateway configuration (port, engines, connectors, logging)
- **cron/jobs.json** → Parse JSON, validate each job, reschedule the valid ones (an invalid job is skipped with a warning, not allowed to block the rest)
- **org/\*\*/\*.yaml** → Rebuild the employee registry from all persona and department YAML files

Changes take effect immediately. No restart required.

## Safety Guidelines

Engines have full file access within `~/.jinn/`. To avoid breaking the gateway:

### Do

- Validate YAML before writing to `config.yaml` (must be valid YAML with expected schema)
- Validate JSON before writing to `jobs.json` or other structured state files
- Use atomic writes (write to temp file, then rename) for critical files
- Back up files before making destructive changes
- Test cron expressions before adding them to `jobs.json`

### Do Not

- Break `config.yaml` structure - invalid YAML will prevent config reload
- Corrupt `sessions/registry.db` - the SQLite database is managed by the gateway process
- Write invalid JSON to `jobs.json` - this will cancel all cron jobs with nothing to replace them
- Delete the `docs/` directory - these reference docs are needed for self-awareness
- Modify files outside `~/.jinn/` unless explicitly instructed by the user

## Example: Creating a Cron Job at Runtime

An engine can create a new cron job by reading `cron/jobs.json`, appending a new entry, and writing it back:

```
1. Read ~/.jinn/cron/jobs.json
2. Parse the JSON array
3. Append new job object with unique id, schedule, prompt, etc.
4. Validate the full array
5. Write back to ~/.jinn/cron/jobs.json
6. The file watcher automatically reschedules all jobs
```

## Example: Adding a New Employee

```
1. Create ~/.jinn/org/<department>/<name>.yaml with required fields
2. The file watcher detects the new file and rebuilds the employee registry
3. The new employee is immediately available for @mention routing
```
