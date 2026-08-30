import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../../../../../docker-entrypoint.sh", import.meta.url));
const dockerConfigure = fileURLToPath(new URL("../../../../../scripts/docker-configure.mjs", import.meta.url));
const dockerfile = fileURLToPath(new URL("../../../../../Dockerfile", import.meta.url));
const composeFile = fileURLToPath(new URL("../../../../../docker-compose.yml", import.meta.url));
const serviceMarker = "__jinn_service_start__";
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.exitCode !== null || child.signalCode !== null
      ? resolve()
      : child.once("exit", () => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { home: string; log: string; ready: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-entrypoint-"));
  dirs.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7777\nengines:\n  default: claude\n  claude: {}\n");
  const log = path.join(root, "commands.log");
  const ready = path.join(root, "gateway-ready");
  const jinn = path.join(bin, "jinn");
  fs.writeFileSync(jinn, `#!/bin/sh
printf '%s|%s\\n' "$*" "\${_JINN_CONTAINER_SERVICE_START:-}" >> "$JINN_TEST_LOG"
if [ "\${1:-}" = start ] && [ "\${JINN_TEST_HOLD_GATEWAY:-}" = 1 ]; then
  printf '%s\n' "$$" > "$JINN_TEST_READY"
  while :; do sleep 1; done
fi
`);
  fs.chmodSync(jinn, 0o755);
  const node = path.join(bin, "node");
  fs.writeFileSync(node, `#!/bin/sh
if [ "\${1:-}" = /opt/jinn/scripts/docker-configure.mjs ]; then
  exec "$JINN_REAL_NODE" "$JINN_TEST_DOCKER_CONFIGURE"
fi
exit 0
`);
  fs.chmodSync(node, 0o755);
  const flock = path.join(bin, "flock");
  fs.writeFileSync(flock, `#!/usr/bin/python3
import fcntl, sys
fd = int(sys.argv[-1])
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(1)
`);
  fs.chmodSync(flock, 0o755);
  return {
    home,
    log,
    ready,
    env: {
      ...process.env,
      HOME: root,
      JINN_HOME: home,
      JINN_TEST_LOG: log,
      JINN_TEST_READY: ready,
      JINN_REAL_NODE: process.execPath,
      JINN_TEST_DOCKER_CONFIGURE: dockerConfigure,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function seedRuntimeRecords(home: string): void {
  fs.writeFileSync(path.join(home, "gateway.pid"), "1\n");
  fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify({
    port: 7777,
    pid: 1,
    secret: "old-container",
    token: "preserve-this-token",
    ptyPids: [7, 9],
  }));
}

describe.skipIf(process.platform === "win32")("Docker entrypoint runtime cleanup", () => {
  it("keeps the entrypoint valid for the runtime image's POSIX shell", () => {
    const result = spawnSync("/bin/sh", ["-n", entrypoint], { encoding: "utf-8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("starts the gateway only through the private default service marker", () => {
    const { env, log } = fixture();

    expect(fs.readFileSync(dockerfile, "utf-8")).toContain(`CMD ["${serviceMarker}"]`);
    expect(fs.readFileSync(composeFile, "utf-8")).toContain(`command: ["${serviceMarker}"]`);
    const result = spawnSync("/bin/sh", [entrypoint, serviceMarker], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, "utf-8")).toBe("start|1\n");
  });

  it("installs and verifies the kernel flock primitive in the runtime image", () => {
    const source = fs.readFileSync(dockerfile, "utf-8");
    expect(source).toMatch(/apt-get install[^\n]*util-linux/);
    expect(source).toContain("command -v flock");
  });

  it("copies every workspace package manifest before installing dependencies", () => {
    const source = fs.readFileSync(dockerfile, "utf-8");
    const installIndex = source.indexOf("RUN pnpm install --frozen-lockfile");
    const packagesDir = path.join(path.dirname(dockerfile), "packages");

    expect(installIndex).toBeGreaterThan(-1);
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `packages/${entry.name}/package.json`;
      if (!fs.existsSync(path.join(path.dirname(dockerfile), manifest))) continue;

      const copyIndex = source.indexOf(`COPY ${manifest} `);
      expect(copyIndex, `${manifest} must be copied before pnpm install`).toBeGreaterThan(-1);
      expect(copyIndex, `${manifest} must be copied before pnpm install`).toBeLessThan(installIndex);
    }
  });

  it("keeps shared STT state inside the persisted Jinn home volume", () => {
    const source = fs.readFileSync(dockerfile, "utf-8");

    expect(source).toContain("ENV JINN_STT_SETTINGS=/home/node/.jinn/stt.json");
    expect(source).toContain("ENV JINN_STT_MODELS_DIR=/home/node/.jinn/models/whisper");
  });

  it("keeps Codex auth state inside its persisted volume", () => {
    const source = fs.readFileSync(dockerfile, "utf-8");
    const compose = fs.readFileSync(composeFile, "utf-8");

    expect(source).toMatch(/RUN mkdir -p [^\n]*\/home\/node\/\.codex[^\n]*\/work/);
    expect(source).toContain("ENV CODEX_HOME=/home/node/.codex");
    expect(compose).toContain("- jinn-codex:/home/node/.codex");
    expect(compose).toContain("  jinn-codex:");
  });

  it("holds an exclusive shared-volume lock before cleanup and releases it on process death", async () => {
    const { home, ready, env } = fixture();
    seedRuntimeRecords(home);
    const holder = spawn("/bin/sh", [entrypoint, serviceMarker], {
      env: { ...env, JINN_TEST_HOLD_GATEWAY: "1" },
      stdio: "ignore",
    });
    children.push(holder);
    await waitForFile(ready);

    const liveInfo = {
      port: 7777,
      pid: holder.pid,
      secret: "live-service",
      token: "live-service-token",
      ptyPids: [71, 72],
    };
    fs.writeFileSync(path.join(home, "gateway.pid"), `${holder.pid}\n`);
    fs.writeFileSync(path.join(home, "gateway.json"), JSON.stringify(liveInfo));

    // A bare `docker compose run --rm jinn` receives the Compose service command;
    // an operator can also spell the private marker explicitly. Neither may pass.
    expect(fs.readFileSync(composeFile, "utf-8")).toContain(`command: ["${serviceMarker}"]`);
    for (const launch of ["bare Compose service command", "explicit marker replay"]) {
      const contenderEnv = { ...env };
      delete contenderEnv.JINN_TEST_HOLD_GATEWAY;
      const contender = spawnSync("/bin/sh", [entrypoint, serviceMarker], {
        env: contenderEnv,
        encoding: "utf-8",
      });
      expect(contender.status, launch).toBe(75);
      expect(contender.stderr, launch).toMatch(/already running|lock|shared.*volume/i);
      expect(fs.readFileSync(path.join(home, "gateway.pid"), "utf-8"), launch).toBe(`${holder.pid}\n`);
      expect(JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf-8")), launch).toEqual(liveInfo);
    }

    expect(fs.existsSync(path.join(home, "gateway.lock"))).toBe(true);
    const gatewayPid = Number.parseInt(fs.readFileSync(ready, "utf-8"), 10);
    process.kill(gatewayPid, "SIGKILL");
    await waitForExit(holder);

    seedRuntimeRecords(home);
    const successorEnv = { ...env };
    delete successorEnv.JINN_TEST_HOLD_GATEWAY;
    const successor = spawnSync("/bin/sh", [entrypoint, serviceMarker], { env: successorEnv, encoding: "utf-8" });
    expect(successor.status, successor.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, "gateway.pid"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf-8"))).toMatchObject({
      pid: 0,
      ptyPids: [],
      token: "preserve-this-token",
    });
  });

  it("clears stale gateway and PTY records in the container-only pre-start step", () => {
    const { home, env } = fixture();
    seedRuntimeRecords(home);

    expect(fs.readFileSync(entrypoint, "utf-8")).toContain("node /opt/jinn/scripts/docker-configure.mjs");
    const result = spawnSync(process.execPath, [dockerConfigure], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, "gateway.pid"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(home, "gateway.json"), "utf-8"))).toMatchObject({
      pid: 0,
      ptyPids: [],
      token: "preserve-this-token",
    });
  });

  it("preserves a safe one-off status command and the live service records", () => {
    const { home, env, log } = fixture();
    seedRuntimeRecords(home);

    const result = spawnSync("/bin/sh", [entrypoint, "jinn", "status"], { env, encoding: "utf-8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, "utf-8")).toBe("status|\n");
    expect(fs.existsSync(path.join(home, "gateway.pid"))).toBe(true);
    expect(fs.existsSync(path.join(home, "gateway.json"))).toBe(true);
  });

  it.each(["setup", "start", "restart"])("rejects one-off jinn %s before it can touch the shared volume", (command) => {
    const { env, log } = fixture();

    const result = spawnSync("/bin/sh", [entrypoint, "jinn", command], { env, encoding: "utf-8" });

    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/service|shared.*volume|already-running/i);
    expect(fs.existsSync(log)).toBe(false);
  });
});
