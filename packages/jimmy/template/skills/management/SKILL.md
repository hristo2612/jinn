---
name: management
description: Manage the AI organization — hire, fire, promote, delegate, and review boards
---

# Management Skill

## Trigger

This skill activates when the user wants to manage their organization: hiring or firing employees, creating departments, promoting or demoting staff, delegating tasks, reviewing task boards, or restructuring teams.

## Organization Structure

The organization lives under the `org/` directory in the Jimmy home folder (`~/.jimmy/org/`). Each department is a subdirectory containing employee persona YAML files and a task board.

```
org/
  engineering/
    department.yaml
    board.json
    lead-developer.yaml
    backend-dev.yaml
  marketing/
    department.yaml
    board.json
    seo-specialist.yaml
```

## Rank Definitions

- **executive** — Full access. Can see all departments and boards. Can hire and fire anyone across the entire organization.
- **manager** — Can manage their own department. Can hire within their department. Can see and manage their department's board.
- **senior** — Can update their own tasks. Can mentor other employees in the department.
- **employee** — Can update their own tasks only.

## Operations

### Hiring an Employee

Create a persona YAML file at `org/<department>/<name>.yaml`.

Required fields:
- `name` — kebab-case identifier (must match filename without extension)
- `displayName` — human-readable name
- `department` — department this employee belongs to (must match parent directory name)
- `rank` — one of: executive, manager, senior, employee
- `engine` — AI engine to use: `claude` or `codex`
- `model` — model identifier (e.g., `sonnet`, `opus`, `o3`)
- `persona` — multiline description of who this employee is and how they behave

Example (`org/marketing/seo-specialist.yaml`):

```yaml
name: seo-specialist
displayName: Sarah SEO
department: marketing
rank: employee
engine: claude
model: sonnet
persona: |
  You are Sarah, an SEO specialist in the marketing department.
  You focus on keyword research, content optimization, and
  technical SEO. You report to the marketing manager.
  Your expertise includes Google Search Console, Ahrefs,
  and content strategy.
```

Steps:
1. Confirm the target department exists under `org/`. If not, ask the user whether to create it first.
2. Choose a kebab-case name for the employee (e.g., `lead-developer`, `seo-specialist`).
3. Ask the user for displayName, rank, engine, model, and persona if not provided.
4. Write the YAML file to `org/<department>/<name>.yaml`.
5. Confirm the hire to the user.

### Firing an Employee

1. Locate the employee's YAML file under `org/<department>/<name>.yaml`.
2. Check if the employee has any active tasks on the department board (`board.json` with status other than `done`). Warn the user if so.
3. Delete the YAML file.
4. Remove the employee as assignee from any tasks in `board.json` (set assignee to `unassigned`).
5. Confirm the removal to the user.

### Creating a Department

1. Create the directory `org/<dept-name>/`.
2. Create `org/<dept-name>/department.yaml` with:
   ```yaml
   name: dept-name
   displayName: Department Display Name
   description: What this department does.
   ```
3. Create `org/<dept-name>/board.json` with an empty array: `[]`
4. Confirm the department creation to the user.

### Promoting or Demoting an Employee

1. Read the employee's YAML file at `org/<department>/<name>.yaml`.
2. Update the `rank` field to the new rank.
3. If promoting to **manager**, add delegation capabilities to their persona (see "Promoting to Manager" below).
4. Write the updated YAML back to the file.
5. Confirm the change to the user, stating the old and new rank.

### Promoting to Manager

When promoting an employee to manager rank, their persona must be extended with delegation capabilities so they can manage their own reports. Append the following to their existing persona:

```yaml
persona: |
  [... existing persona content ...]

  ## Manager Responsibilities
  You are the manager of the [department] department. In addition to your
  technical expertise, you:

  - Manage and delegate tasks to employees in your department
  - You can spawn child sessions via the gateway API to delegate work
  - Apply oversight levels to your reports' work:
    - TRUST: simple lookups, status checks — relay directly
    - VERIFY: code changes, routine work — spot-check key outputs
    - THOROUGH: architecture, breaking changes — full review, multi-turn
  - Report summaries back to the COO (Jimmy), not raw employee output
  - Use the department board (board.json) to track task status
  - When given a task by the COO, decide whether to do it yourself or
    delegate to the right employee based on their skills and workload

  ## Delegation API
  - Create child session: POST /api/sessions with parentSessionId
  - Send follow-up: POST /api/sessions/:id/message
  - Poll status: GET /api/sessions/:id
  - List your reports: GET /api/org
```

**When to suggest promoting to manager:**
- A department has 3+ employees
- You're spending excessive time on per-employee delegation in that department
- A senior employee has consistently delivered high-quality work
- The user explicitly requests it

### Delegating Tasks

Add a task object to the department's `board.json` file.

Task object schema:

```json
{
  "id": "uuid-v4",
  "title": "Short description of the task",
  "assignee": "employee-name",
  "status": "todo",
  "priority": "high",
  "description": "Detailed description of what needs to be done.",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-15T10:30:00.000Z"
}
```

Field details:
- `id` — generate a UUID v4
- `title` — short, descriptive title
- `assignee` — the `name` field from the employee's YAML (must match an existing employee in the department)
- `status` — one of: `todo`, `in-progress`, `review`, `done`
- `priority` — one of: `high`, `medium`, `low`
- `description` — detailed task description
- `createdAt` — ISO 8601 timestamp when the task was created
- `updatedAt` — ISO 8601 timestamp, same as createdAt initially

Steps:
1. Read the current `board.json` for the department.
2. Verify the assignee exists as an employee in that department.
3. Generate a new task object with a UUID.
4. Append the task to the array.
5. Write the updated array back to `board.json`.
6. Confirm the delegation to the user.

### Reviewing Boards

1. Read the department's `board.json`.
2. Present tasks grouped by status: todo, in-progress, review, done.
3. Include priority and assignee for each task.
4. If the user wants to update a task status, modify the task's `status` and `updatedAt` fields in the JSON array and write it back.

### Restructuring (Moving Employees Between Departments)

1. Read the employee's YAML from the source department.
2. Update the `department` field to the new department name.
3. Write the YAML to the new department directory.
4. Delete the YAML from the old department directory.
5. Move any assigned tasks from the old board to the new board (or reassign them, based on user preference).
6. Confirm the move to the user.

## Communication Rules

- Messages from higher-ranked employees can reference and direct lower-ranked employees.
- @mentions in messages (e.g., `@seo-specialist`) route to the mentioned employee's engine and model as defined in their persona YAML.
- An executive can message anyone. A manager can message employees within their department. Seniors and employees can message peers and their manager.

## Error Handling

- If a department does not exist when hiring, offer to create it.
- If an employee name conflicts with an existing file, warn the user and ask for a different name.
- If `board.json` is malformed, attempt to parse and fix it. If unrecoverable, back it up and create a fresh empty board.
- Always validate YAML before writing to ensure it is well-formed.
