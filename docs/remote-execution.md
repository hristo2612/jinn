# Remote (SSH) execution

By default every employee's Claude Code session is spawned as a real interactive
TUI on the machine running the gateway. An employee that declares a `remoteHost`
is spawned through `ssh` on another machine instead, and everything it does —
repository checkouts, builds, tests — happens there.

The motivating case is a gateway on a small always-on box (a Raspberry Pi, a
NAS, a cheap VPS) driving a powerful desktop that does the actual work. No
repository is ever cloned onto the gateway.

This is **opt-in per employee** and fails closed: without a `remote` block in
`config.yaml`, an employee naming a `remoteHost` refuses to load and says why.

## What a remote employee keeps

A remote employee is a full employee, not a degraded one:

| | Where it runs |
|---|---|
| Todos, Notes, work items, delegation, knowledge reads | The gateway, via the built-in `jinn` MCP server over the tunnel |
| Skills, `docs/`, `knowledge/`, `org/`, `secrets/` | The gateway, via the mounted instance home |
| Hooks (turn completion, tool events, safety prompts) | Delivered to the gateway over the reverse tunnel |
| The dashboard's live terminal view | Attached to the remote PTY |
| Repository code, builds, tests, scratch files | The remote host — the point of the feature |

The one deliberate omission is **live token-by-token streaming**. A remote
session runs without the per-PTY SSE proxy, so the chat pane fills in when the
turn ends rather than as it goes. Turn results, hook-driven tool activity, and
blocked-on-a-question notifications are unaffected.

## Prerequisites on the remote host

1. **Claude Code**, installed and signed in on the same plan the gateway uses.
   If the host uses a profile manager, see *Choosing a Claude Code profile*
   below — do not point Jinn at the wrapper script.
2. **Node.js**. Note the PATH caveat below — this is the single most likely
   thing to bite you.
3. **`jinn-cli` at the gateway's exact version**, installed globally:
   `npm install -g jinn-cli@<version>`. It is never started as a daemon there —
   it supplies the MCP server entrypoints, which are absolute paths that must
   exist on that machine. A version mismatch is refused at spawn with the
   command that fixes it.
4. **The gateway's instance home, sshfs-mounted.** For example:
   ```
   sshfs gateway-host:/home/<gateway-user>/.jinn /mnt/jinn-home -o reconnect,ServerAliveInterval=15
   ```
   Mount it from `/etc/fstab` or a systemd automount so it survives a reboot,
   and set `remote.remountCommand` so the gateway can re-establish it after a
   wake.
### The non-interactive PATH caveat

Sessions reach the remote host over a non-interactive `ssh` command, which reads
**no** shell rc file. A host whose Node comes from a version manager (nvm, fnm,
asdf) therefore looks like it has no `node` at all:

```
ssh build-box 'command -v node'     # prints nothing
ssh build-box                        # ...but node works fine once logged in
```

This matters twice over. The obvious half is that the preflight cannot find
`node` or `jinn`. The dangerous half is that Claude Code invokes **every hook**
as bare `node`, so without a resolvable `node` no hook could start — no `Stop`
would ever arrive and the turn would hang forever with nothing reported.

Jinn resolves nvm's layout directly rather than sourcing `nvm.sh` (which is
bash-only, and `/bin/sh` is `dash` on Debian-family systems including Raspberry
Pi OS), honouring nvm's `default` alias — a global `jinn-cli` lives under one
version's tree, so taking the newest version instead would report jinn missing
on a host where it is installed perfectly well. The resolved directory is then
prepended to the session's PATH so the hook relay runs.

If your host uses something Jinn cannot resolve, the fix is one symlink onto the
default PATH:

```bash
ln -s "$(command -v node)" ~/.local/bin/node
```

Verify with `ssh <host> 'command -v node claude jinn'` — all three must print.

5. **Key-only SSH from the gateway.** Sessions run with `BatchMode=yes`, so a
   passphrase-locked key with no agent will simply fail. The host key must
   already be in the gateway's `known_hosts` — Jinn will not accept a new host
   key on your behalf.

## Configuration

In `config.yaml`:

```yaml
remote:
  # Every remoteCwd must resolve under this prefix on the remote host.
  root: /srv/jinn-work
  # Where the gateway's own instance home is sshfs-mounted over there.
  mount: /mnt/jinn-home
  # Optional. Bring a sleeping host up. wakeCommand wins over wakeMac.
  wakeMac: "aa:bb:cc:dd:ee:ff"
  # wakeCommand: "smartplug on workstation"
  # Run on the remote once it is reachable, to bring the mount back after a boot.
  remountCommand: "systemctl --user start jinn-home.mount"
  # Which Claude Code profile remote sessions run as. Omit for the remote
  # user's default. An employee's remoteClaudeConfigDir overrides it.
  claudeConfigDir: /home/<user>/.claude-profiles/personal
  # How long wakeCommand may run before it is killed. Default 300000 (5 min).
  wakeTimeoutMs: 300000
  # Bound on waiting for an unreachable host. Default 240000 (4 minutes).
  waitMs: 300000
```

In the employee's YAML under `<instance home>/org/<department>/<name>.yaml`:

```yaml
name: builder
displayName: Builder
department: engineering
rank: senior
engine: claude
model: opus
remoteHost: build-box
remoteUser: jinn
remoteCwd: /srv/jinn-work/main
persona: |
  You are Builder. You work on the main repository checked out at your
  working directory. Build and test there; record findings as Notes.
```

These three fields are YAML-only on purpose — they are **not** editable through
the employee-edit API. Being able to repoint where an unattended
`--dangerously-skip-permissions` session executes is not a dashboard-sized
decision.

## Choosing a Claude Code profile

If the remote host keeps several Claude Code profiles (a personal one and a work
one, say), name the one a session should use:

```yaml
remote:
  claudeConfigDir: /home/<user>/.claude-profiles/personal
```

An employee can override it, because which profile to use is a property of the
employee rather than the machine:

```yaml
remoteClaudeConfigDir: /home/<user>/.claude-profiles/work
```

**Do not point Jinn at a profile-manager wrapper instead.** Those wrappers set
`CLAUDE_CONFIG_DIR` and then `unset` every `CLAUDE_*` and `ANTHROPIC_*` variable
before exec. That strips the three a session depends on — and losing
`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` lets the "resume from summary?" picker
appear in front of a PTY with nobody at the keyboard, which hangs the turn. Jinn
sets the variable itself and runs the plain binary, getting the profile without
the collateral damage.

Two consequences follow, both handled for you:

- **The folder-trust seed runs under the same profile.** Claude Code keeps
  `.claude.json` *inside* `CLAUDE_CONFIG_DIR`, so seeding without it writes
  `~/.claude.json` while the session reads `<profile>/.claude.json` — the trust
  dialog would still appear and the first turn would hang. The seed cache is
  keyed on the profile too, so switching profiles re-seeds rather than assuming
  the old seed still counts.
- **An unsigned-in profile is refused up front.** A profile directory with no
  `.credentials.json` makes `claude` open a login prompt nothing can answer, so
  the spawn is refused with that reason instead of hanging.

When no profile is configured, `CLAUDE_CONFIG_DIR` is actively *unset* for the
session, so a stray value in the remote environment cannot silently choose the
credentials and trust state a session runs with.

`jinn remote status` prints the resolved profile per employee.

## The sandbox root

`remoteCwd` must resolve under `remote.root`, checked when the org loads and
again immediately before the spawn command is built. Traversal is normalized
away first, and a sibling that merely shares a prefix (`/srv/jinn-work-other`
against `/srv/jinn-work`) is refused.

This does not stop a determined prompt from `cd ..`-ing out of the directory
once the session is running. It is not a sandbox. What it does is bound the
realistic accidental blast radius of running unattended with
`--dangerously-skip-permissions` on a machine somebody also uses for other
things, which is the failure actually worth designing against.

## How the pieces reach back

The gateway's hook endpoint only accepts loopback connections, and that check is
not relaxed for remote sessions. Instead the session's `ssh` carries a reverse
forward (`-R`) from a free port on the remote host back to the gateway's own
port. The remote `hook-relay.mjs` and the remote MCP servers talk to
`127.0.0.1:<forwarded port>`, so their requests arrive at the gateway as genuine
loopback traffic with no change to the authentication path at all.

The port is probed on the remote immediately before the spawn, and the session
is started with `ExitOnForwardFailure=yes`. If something claimed the port in
between, `ssh` exits at once instead of running a session whose hooks could
never arrive — a fast, visible failure rather than a turn that hangs forever.

Each session gets its **own** `$JINN_HOME` on the remote host, at
`~/.jinn-remote-stage/sessions/<session id>`: a directory of symlinks into the
mount, rebuilt on every spawn, with two exceptions — `gateway.json` (staged for
real, naming that session's forwarded port) and `tmp/` (a real local directory,
because per-session files churn there and a network filesystem is the wrong
place for it).

Per session rather than per host, because `gateway.json` names a port that is
allocated per spawn. With one shared copy, any second prepare — another employee
on the same box — rewrites the port a live session's hook relay is about to
read. The relay swallows a failed POST by design, so that turn would run to
completion with no `Stop`, no `PreToolUse` policy, and nothing reported
anywhere. Stale session directories are reaped after seven days by the same
script that rebuilds the farm.

`hook-relay.mjs` and `remote-trust-seed.mjs` are staged as real copies at
`~/.jinn-remote-stage/` itself — deliberately outside every session's farm, so
the farm rebuild cannot turn them back into symlinks into the mount. Hooks fire
many times a turn, and a relay that cannot run because the mount blipped would
take the turn's completion signal with it. Their presence is re-checked on every
spawn (the farm script reports it, at no extra cost), so a wiped stage restages
itself rather than staying broken until the gateway restarts.

`JINN_GATEWAY_URL` (pointing at the tunnel) and `JINN_GATEWAY_TOKEN` are written
into a 0600 shell fragment under the session's `tmp/` and sourced by the remote
command. The system prompt tells every session both are already exported, and
every documented `curl` in it — delegation included — depends on that being
true. They are sourced from a file rather than inlined into the remote command
because a command line is readable by every process on that host.

## When the host is off

A desktop is usually off, so this is part of the feature rather than an error
case. When a turn starts and the host is unreachable, the gateway sends the wake
(`wakeCommand`, else a Wake-on-LAN magic packet), moves the session to
`waiting`, tells the operator, and polls until `waitMs` runs out.

A `wakeCommand` gets `wakeTimeoutMs` (default five minutes) to finish. That is
deliberately generous: a real startup path is not a fire-and-forget packet — it
may probe reachability, read a power state over the network, press a physical
ATX button and then wait for the machine to POST. Killing it partway through can
land between the state read and the press, so nothing wakes and the turn simply
times out. Give the command room to complete rather than backgrounding it, so
its exit code and stderr are still yours to read when it fails. On success the
turn proceeds; on timeout the turn fails with a message naming the host.

Two deliberate asymmetries:

- **The dashboard's terminal view never wakes anything.** Opening a tab should
  not boot someone's machine, so the idle path probes and reports rather than
  waking.
- **Nothing is written to the engine-health store.** That store is keyed by
  engine *name* and is consulted for every session, so recording "claude is
  unavailable" because one desktop is asleep would hold back every local
  employee's turns too.

`jinn remote status` reports what a turn would find right now, without waking
anything. `jinn remote wake <employee>` brings a host up without queueing work
into it. Neither is on the turn path — a turn wakes and verifies its own host,
because making that depend on somebody remembering to run a command would put
"the session silently never started" back on the table.

## Known limits

- **Cost and transcript accounting read empty for remote turns.** The gateway
  reads Claude Code transcripts from its own home; a remote session writes them
  on the remote host. `--resume` is unaffected — the remote CLI manages its own
  transcript consistently across turns.
- **A lost `Stop` hook cannot be recovered from the transcript** for the same
  reason, so a genuinely stalled remote turn fails rather than recovering its
  text.
- **No `/usage` reset hints**, since the status-line recorder would write where
  the gateway cannot read.
- **Attachments are refused** on remote turns: the paths are local to the
  gateway and would name nothing on the other machine.
- **The write guardrail is defence in depth, not a sandbox.** The `PreToolUse`
  policy refuses writes to an instance-home-shaped path outside the verified
  mount, and understands `/`, `~/` and `$HOME/` targets. It cannot see a path
  assembled at runtime, one built inside `python -c`, or one reached through a
  relative `cd`. The **mount sentinel** is the primary guard precisely because
  it does not read the command at all: it is verified before every spawn and
  refuses to start the session when the mount is not live. The policy also errs
  towards over-blocking — it refuses when a write-shaped command mentions an
  offending path anywhere, not only as its target — which is the safe direction
  for a rule of this kind.
- **Only the `claude` engine can go remote.** Every other engine ignores
  `remoteHost`, so a remote employee configured with one has its turns refused
  rather than silently run on the gateway.
- **Secrets reach a second machine.** The gateway's API bearer token and any MCP
  server API keys are staged into 0600 files on the remote host, and the mount
  makes the instance home — including `secrets/` — readable there. This is
  inherent to a remote employee being as capable as a local one. Treat the
  remote host as being inside the same trust boundary as the gateway, and do not
  point this at a machine you would not give the instance home to.
