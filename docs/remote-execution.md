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

The remote session's `$JINN_HOME` is a directory of symlinks into the mount,
rebuilt on every spawn, with two exceptions: `gateway.json` (staged for real,
naming the forwarded port) and `tmp/` (a real local directory, because
per-session files churn there and a network filesystem is the wrong place for
it).

## When the host is off

A desktop is usually off, so this is part of the feature rather than an error
case. When a turn starts and the host is unreachable, the gateway sends the wake
(`wakeCommand`, else a Wake-on-LAN magic packet), moves the session to
`waiting`, tells the operator, and polls until `waitMs` runs out. On success the
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
- **Secrets reach a second machine.** The gateway's API bearer token and any MCP
  server API keys are staged into 0600 files on the remote host, and the mount
  makes the instance home — including `secrets/` — readable there. This is
  inherent to a remote employee being as capable as a local one. Treat the
  remote host as being inside the same trust boundary as the gateway, and do not
  point this at a machine you would not give the instance home to.
