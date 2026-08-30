# Skills

Skills are Markdown playbooks that engines discover and follow natively. Each directory under `$JINN_HOME/skills/` contains a `SKILL.md` with YAML frontmatter whose `name` matches the directory and whose `description` says when the skill applies.

Read the relevant playbook before acting. Keep durable procedure in the skill, supporting material beside it, and only a short routing pointer in root instructions or employee personas.

## Shipped skills

- **cron-manager**: Manage scheduled jobs and inspect run history.
- **delegation**: Delegate tracked work and coordinate child sessions.
- **experiments**: Create, measure, update, and conclude experiments.
- **find-and-install**: Find and install community skills.
- **management**: Manage departments, employees, hierarchy, and ownership.
- **new**: Start a fresh chat session.
- **notes**: Find, read, create, and safely update durable Notes.
- **onboarding**: Guide a new operator through first-run setup.
- **self-heal**: Diagnose and repair configuration or runtime problems.
- **skill-creator**: Create focused local skills.
- **status**: Report current session and system status.
- **sync**: Catch up on an employee conversation.
- **todo-handling**: Create, assign, update, review, and archive Todos.
- **workflow**: Create, invoke, observe, and maintain Workflows.

## Creating or installing

Use `skill-creator` for a recurring local procedure. Use `find-and-install` when a trusted community skill may already cover the gap. Search is read-only; get approval before installation.

Keep skills focused, executable, and free of secrets. Put examples or scripts beside the playbook only when they are needed to carry out its procedure.
