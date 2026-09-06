import { beforeAll, describe, expect, it } from "vitest";
import "./helpers/stub-callback-recovery.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE, ensureSessionCapability,
} from "../../mcp/identity.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-control-plane-"));
process.env.JINN_HOME = tmpHome;
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-control-plane-wf-"));

const safePortalName = "Portal COO";
const collidingPortalName = "platform-worker";
const orgDir = path.join(tmpHome, "org", "platform");
const skillDir = path.join(tmpHome, "skills", "sample-skill");
const cronDir = path.join(tmpHome, "cron");

function writeConfig(portalName = safePortalName) {
  fs.writeFileSync(
    path.join(tmpHome, "config.yaml"),
    yaml.dump({
      gateway: {},
      engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
      portal: { portalName, setupComplete: true },
      stt: { languages: ["en"] },
      connectors: {},
      mcp: {},
      sessions: {},
    }),
  );
}

function readConfig(): Record<string, any> {
  return yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")) as Record<string, any>;
}

writeConfig();
fs.mkdirSync(orgDir, { recursive: true });
fs.mkdirSync(skillDir, { recursive: true });
fs.mkdirSync(cronDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, "department.yaml"), "name: platform\n");
fs.writeFileSync(
  path.join(orgDir, "platform-manager.yaml"),
  "name: platform-manager\ndisplayName: Platform Manager\ndepartment: platform\nrank: manager\nengine: codex\nmodel: gpt-5.5\npersona: Manages platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Executes platform work.\n",
);
fs.writeFileSync(
  path.join(orgDir, "platform-peer.yaml"),
  "name: platform-peer\ndisplayName: Platform Peer\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Reviews peer work.\n",
);
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: sample-skill\ndescription: Generic sample skill.\n---\n\n# Sample\n");
fs.writeFileSync(path.join(cronDir, "jobs.json"), JSON.stringify([{ id: "existing", name: "Existing", enabled: false, schedule: "0 * * * *", prompt: "Run." }], null, 2));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
type ApprovalAuthority = typeof import("../approval-authority.js");
type Auth = typeof import("../auth.js");

let api: Api;
let registry: Registry;
let store: Store;
let approvals: Approvals;
let approvalAuthority: ApprovalAuthority;
let auth: Auth;
let worker: import("../../shared/types.js").Session;
let peer: import("../../shared/types.js").Session;
let manager: import("../../shared/types.js").Session;

const apiCtx = {
  getConfig: () => readConfig(),
  reloadConfig: () => {},
  reloadOrg: () => {},
  reloadConnectorInstances: async () => ({ reloaded: true }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const headers = new Map<string, unknown>();
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get bodyText() {
      return Buffer.concat(chunks).toString("utf-8");
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body, bodyText: cap.bodyText, header: cap.header };
}

function toolHeaders(session: import("../../shared/types.js").Session): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: session.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(session.id),
  };
}

function resetCronJobs() {
  fs.writeFileSync(path.join(cronDir, "jobs.json"), JSON.stringify([{ id: "existing", name: "Existing", enabled: false, schedule: "0 * * * *", prompt: "Run." }], null, 2));
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  approvalAuthority = await import("../approval-authority.js");
  auth = await import("../auth.js");
  (await import("../../shared/db.js")).initDb();
  worker = registry.createSession({ engine: "codex", source: "web", sourceRef: "worker", title: "worker", employee: "platform-worker" });
  peer = registry.createSession({ engine: "codex", source: "web", sourceRef: "peer", title: "peer", employee: "platform-peer" });
  manager = registry.createSession({ engine: "codex", source: "web", sourceRef: "manager", title: "manager", employee: "platform-manager" });
});

describe("control-plane writes require operator authority", () => {
  it("makes callback dead letters visible to managers while guarding atomic requeue authority", async () => {
    const delivery = registry.claimSessionDelivery({
      targetSessionId: "callback-parent",

      sourceKind: "session",
      sourceId: "callback-child",
      sourceAttempt: "callback-attempt",
      sourceOutcome: "failed",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "recover callback", displayMessage: "Worker failed" },
    }).delivery;
    const attemptedAt = Date.parse(delivery.createdAt);
    registry.claimSessionDeliveryAttempt(delivery.id, attemptedAt, 100);
    registry.recordSessionDeliveryFailure(delivery.id, "temporary outage", {
      now: attemptedAt,
      nextAttemptAt: attemptedAt + 1_000,
      maxAttempts: 1,
    });

    expect((await call("GET", "/api/callback-deliveries/dead-letter")).status).toBe(403);
    expect((await call("GET", "/api/callback-deliveries/dead-letter", undefined, toolHeaders(worker))).status).toBe(403);

    const managerList = await call(
      "GET",
      "/api/callback-deliveries/dead-letter",
      undefined,
      toolHeaders(manager),
    );
    expect(managerList.status).toBe(200);
    expect(managerList.body).toMatchObject({
      deliveries: [expect.objectContaining({ id: delivery.id, status: "dead_letter", lastError: "temporary outage" })],
    });

    const requeued = await call(
      "POST",
      `/api/callback-deliveries/${delivery.id}/requeue`,
      {},
      { authorization: "Bearer test-token" },
    );
    expect(requeued.status).toBe(200);
    expect(requeued.body).toMatchObject({ delivery: { id: delivery.id, status: "pending", attemptCount: 0 } });

    const acceptedParent = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "accepted-parent",
      sessionKey: "accepted-parent",
    });
    const accepted = registry.claimSessionDelivery({
      targetSessionId: acceptedParent.id,

      sourceKind: "session",
      sourceId: "accepted-child",
      sourceAttempt: "accepted-attempt",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "accepted callback", displayMessage: "Worker replied" },
    }).delivery;
    registry.acceptSessionDelivery(accepted.id, acceptedParent.id, acceptedParent.sessionKey);
    const rejected = await call(
      "POST",
      `/api/callback-deliveries/${accepted.id}/requeue`,
      {},
      { authorization: "Bearer test-token" },
    );
    expect(rejected.status).toBe(409);
    expect(registry.getSessionDelivery(accepted.id)).toMatchObject({ status: "accepted" });
  });
  it("fails anonymous Todo writes closed while bearer, cookie, and session capabilities keep their exact authority", async () => {
    const anonymousAssign = store.createWorkItem({ title: "Anonymous assign target", status: "assigned", assignee: "platform-worker", source: "human" });
    const anonymousArchive = store.createWorkItem({ title: "Anonymous archive target", status: "assigned", assignee: "platform-worker", source: "human" });

    expect((await call("POST", `/api/work-items/${anonymousAssign.id}/assign`, { assignee: "platform-peer" })).status).toBe(403);
    expect((await call("POST", `/api/work-items/${anonymousArchive.id}/archive`, { note: "anonymous" })).status).toBe(403);
    expect(store.getWorkItem(anonymousAssign.id)).toMatchObject({ assignee: "platform-worker", status: "assigned" });
    expect(store.getWorkItem(anonymousArchive.id)?.status).toBe("assigned");

    const bearerHeaders = { authorization: "Bearer test-token" };
    const bearerAssign = store.createWorkItem({ title: "Bearer assign target", status: "assigned", assignee: "platform-worker", source: "human" });
    const bearerArchive = store.createWorkItem({ title: "Bearer archive target", status: "assigned", assignee: "platform-worker", source: "human" });
    expect((await call("POST", `/api/work-items/${bearerAssign.id}/assign`, { assignee: "platform-peer" }, bearerHeaders)).status).toBe(200);
    expect((await call("POST", `/api/work-items/${bearerArchive.id}/archive`, {}, bearerHeaders)).status).toBe(200);

    const bootstrap = await call("POST", "/api/auth/bootstrap", {}, {
      [auth.LOCAL_BOOTSTRAP_GRANT_HEADER]: auth.issueLocalBootstrapGrant(),
    });
    expect(bootstrap.status).toBe(200);
    const rawCookies = Array.isArray(bootstrap.header("set-cookie")) ? bootstrap.header("set-cookie") : [bootstrap.header("set-cookie")];
    const cookie = (rawCookies as string[]).map((part) => part.split(";")[0]).join("; ");
    const cookieAssign = store.createWorkItem({ title: "Cookie assign target", status: "assigned", assignee: "platform-worker", source: "human" });
    const cookieArchive = store.createWorkItem({ title: "Cookie archive target", status: "assigned", assignee: "platform-worker", source: "human" });
    expect((await call("POST", `/api/work-items/${cookieAssign.id}/assign`, { assignee: "platform-peer" }, { cookie })).status).toBe(200);
    expect((await call("POST", `/api/work-items/${cookieArchive.id}/archive`, {}, { cookie })).status).toBe(200);

    const scopedTarget = store.createWorkItem({ title: "Scoped authority target", status: "assigned", assignee: "platform-worker", source: "human" });
    expect((await call("POST", `/api/work-items/${scopedTarget.id}/assign`, { assignee: "platform-peer" }, toolHeaders(peer))).status).toBe(403);
    expect(store.getWorkItem(scopedTarget.id)?.assignee).toBe("platform-worker");
    const claimable = store.createWorkItem({ title: "Scoped self claim", status: "backlog", assignee: null, source: "human" });
    expect((await call("POST", `/api/work-items/${claimable.id}/assign`, { assignee: "platform-peer" }, toolHeaders(peer))).status).toBe(200);
    expect(store.getWorkItem(claimable.id)).toMatchObject({ assignee: "platform-peer", status: "assigned" });
  });

  it("rejects a capability-bound worker PUT /api/config and leaves portalName unchanged", async () => {
    writeConfig();

    const resp = await call("PUT", "/api/config", { portal: { portalName: collidingPortalName } }, toolHeaders(worker));

    expect(resp.status).toBe(403);
    expect(resp.bodyText).toMatch(/operator.*control-plane/i);
    expect(readConfig().portal.portalName).toBe(safePortalName);
  });

  it("keeps operator/browser config writes working", async () => {
    writeConfig();

    const resp = await call("PUT", "/api/config", { portal: { portalName: "Operator Portal" } }, { authorization: "Bearer test-token" });

    expect(resp.status).toBe(200);
    expect(readConfig().portal.portalName).toBe("Operator Portal");
    writeConfig();
  });

  it("reports the effective Todo prefix, permits renames, and validates a malformed prefix", async () => {
    writeConfig();

    const before = await call("GET", "/api/onboarding");
    expect(before.status).toBe(200);
    // Todos v2: allocation is per-prefix, so the company prefix never freezes.
    expect(JSON.parse(before.bodyText)).toMatchObject({ todoPrefix: "JIN", todoPrefixFrozen: false });

    const valid = await call("POST", "/api/onboarding", { companyName: "IC-IDEV", companyPrefix: "JIN" }, {
      authorization: "Bearer test-token",
    });
    expect(valid.status).toBe(200);
    expect(readConfig().portal.companyName).toBe("IC-IDEV");

    const renamed = await call("POST", "/api/onboarding", { companyName: "AI" }, {
      authorization: "Bearer test-token",
    });
    expect(renamed.status).toBe(200);
    expect(readConfig().portal.companyName).toBe("AI");

    const reprefixed = await call("POST", "/api/onboarding", { companyPrefix: "ACM" }, {
      authorization: "Bearer test-token",
    });
    expect(reprefixed.status).toBe(200);
    expect(readConfig().portal.companyPrefix).toBe("ACM");

    const malformed = await call("POST", "/api/onboarding", { companyPrefix: "nope" }, {
      authorization: "Bearer test-token",
    });
    expect(malformed.status).toBe(400);
    expect(readConfig().portal.companyPrefix).toBe("ACM");
    writeConfig();
  });

  it("rejects capability-bound auth bootstrap and pair before they mint operator cookies", async () => {
    const bootstrap = await call("POST", "/api/auth/bootstrap", {}, toolHeaders(worker));
    expect(bootstrap.status).toBe(403);
    expect(bootstrap.header("set-cookie")).toBeUndefined();

    const pair = await call("POST", "/api/auth/pair", { token: "test-token" }, toolHeaders(worker));
    expect(pair.status).toBe(403);
    expect(pair.header("set-cookie")).toBeUndefined();
  });

  it("rejects anonymous loopback bootstrap before it can mint operator cookies", async () => {
    const bootstrap = await call("POST", "/api/auth/bootstrap", {});

    expect(bootstrap.status).toBe(401);
    expect(bootstrap.header("set-cookie")).toBeUndefined();
  });

  it("accepts a genuine one-time UI launch grant and rejects its replay", async () => {
    const grant = auth.issueLocalBootstrapGrant();
    const headers = { [auth.LOCAL_BOOTSTRAP_GRANT_HEADER]: grant };

    const bootstrap = await call("POST", "/api/auth/bootstrap", {}, headers);
    expect(bootstrap.status).toBe(200);
    expect(String(bootstrap.header("set-cookie"))).toContain(`${auth.authCookieName(tmpHome)}=`);

    const replay = await call("POST", "/api/auth/bootstrap", {}, headers);
    expect(replay.status).toBe(401);
    expect(replay.header("set-cookie")).toBeUndefined();
  });

  it("rejects no-scoped-header token pairing so global gateway tokens cannot mint browser cookies", async () => {
    const pair = await call("POST", "/api/auth/pair", { token: "test-token" });

    expect(pair.status).toBe(401);
    expect(pair.header("set-cookie")).toBeUndefined();
  });

  it("rejects bearer-issued pairing codes, including scoped callers carrying bearer auth", async () => {
    const challenge = await call("POST", "/api/auth/pairing-challenges", {}, toolHeaders(worker));
    expect(challenge.status).toBe(403);
    expect(challenge.body.challengeId).toBeUndefined();

    const bearer = await call("POST", "/api/auth/pairing-codes", {}, { authorization: "Bearer test-token" });
    expect(bearer.status).toBe(403);
    expect(bearer.body.code).toBeUndefined();

    const scopedBearer = await call("POST", "/api/auth/pairing-codes", {}, { ...toolHeaders(worker), authorization: "Bearer test-token" });
    expect(scopedBearer.status).toBe(403);
    expect(scopedBearer.body.code).toBeUndefined();
  });

  it("keeps genuine browser bootstrap/pairing-code pair and cookie-backed config writes working", async () => {
    writeConfig();

    const bootstrap = await call("POST", "/api/auth/bootstrap", {}, {
      [auth.LOCAL_BOOTSTRAP_GRANT_HEADER]: auth.issueLocalBootstrapGrant(),
    });
    expect(bootstrap.status).toBe(200);
    expect(String(bootstrap.header("set-cookie"))).toContain(`${auth.authCookieName(tmpHome)}=`);

    const bootstrapCookies = Array.isArray(bootstrap.header("set-cookie")) ? bootstrap.header("set-cookie") : [bootstrap.header("set-cookie")];
    const bootstrapCookieHeader = (bootstrapCookies as string[]).map((part) => part.split(";")[0]).join("; ");
    const pairingCode = await call("POST", "/api/auth/pairing-codes", {}, { cookie: bootstrapCookieHeader });
    expect(pairingCode.status).toBe(200);

    const pair = await call("POST", "/api/auth/pair", { code: pairingCode.body.code });
    expect(pair.status).toBe(200);
    expect(String(pair.header("set-cookie"))).toContain(`${auth.authCookieName(tmpHome)}=`);
    const rawCookies = Array.isArray(pair.header("set-cookie")) ? pair.header("set-cookie") : [pair.header("set-cookie")];
    const cookieHeader = (rawCookies as string[]).map((part) => part.split(";")[0]).join("; ");

    const configWrite = await call("PUT", "/api/config", { portal: { portalName: "Cookie Operator" } }, { cookie: cookieHeader });
    expect(configWrite.status).toBe(200);
    expect(readConfig().portal.portalName).toBe("Cookie Operator");
    writeConfig();
  });

  it.each([
    { method: "POST", path: "/api/cron", body: { id: "worker-job", name: "Worker Job", schedule: "* * * * *", prompt: "Run." }, label: "cron create" },
    { method: "PUT", path: "/api/cron/existing", body: { enabled: true }, label: "cron update" },
    { method: "DELETE", path: "/api/cron/existing", body: undefined, label: "cron delete" },
    { method: "POST", path: "/api/cron/existing/trigger", body: {}, label: "cron manual trigger" },
    { method: "PATCH", path: "/api/org/employees/platform-worker", body: { displayName: "Renamed Worker" }, label: "org employee update" },
    { method: "DELETE", path: "/api/skills/sample-skill", body: undefined, label: "skill removal" },
    { method: "POST", path: "/api/engines/refresh", body: {}, label: "engine registry refresh" },
    { method: "POST", path: "/api/engine-limits/refresh", body: {}, label: "engine limits refresh" },
    { method: "POST", path: "/api/connectors/reload", body: {}, label: "connector reload" },
    { method: "POST", path: "/api/onboarding", body: { portalName: "Worker Portal" }, label: "onboarding config write" },
    { method: "POST", path: "/api/stt/download", body: {}, label: "stt model download/config enable" },
    { method: "PUT", path: "/api/stt/config", body: { languages: ["en"] }, label: "stt config" },
    { method: "DELETE", path: "/api/auth/devices/device-1", body: undefined, label: "auth device revoke" },
  ])("rejects capability-bound workers on $label", async (route) => {
    resetCronJobs();
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: sample-skill\ndescription: Generic sample skill.\n---\n\n# Sample\n");

    const resp = await call(route.method, route.path, route.body, toolHeaders(worker));

    expect(resp.status).toBe(403);
    expect(resp.bodyText).toMatch(/operator.*control-plane/i);
  });

  it("rejects capability-bound callers on destructive session and queue controls", async () => {
    const target = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "target-control",
      title: "target control",
      employee: "platform-worker",
    });
    const originalTitle = target.title;
    const routes = [
      { method: "PATCH", path: `/api/sessions/${target.id}`, body: { title: "Worker changed victim" }, label: "session metadata patch" },
      { method: "POST", path: `/api/sessions/${target.id}/duplicate`, body: {}, label: "session duplicate" },
      { method: "DELETE", path: `/api/sessions/${target.id}`, body: undefined, label: "session delete" },
      { method: "POST", path: `/api/sessions/${target.id}/reset`, body: {}, label: "session reset" },
      { method: "DELETE", path: `/api/sessions/${target.id}/queue/qi_missing`, body: undefined, label: "queue item cancel" },
      { method: "DELETE", path: `/api/sessions/${target.id}/queue`, body: undefined, label: "queue clear" },
      { method: "POST", path: `/api/sessions/${target.id}/queue/pause`, body: {}, label: "queue pause" },
      { method: "POST", path: `/api/sessions/${target.id}/queue/resume`, body: {}, label: "queue resume" },
      { method: "POST", path: "/api/sessions/bulk-delete", body: { ids: [target.id] }, label: "bulk delete" },
    ];

    for (const route of routes) {
      const resp = await call(route.method, route.path, route.body, toolHeaders(worker));
      expect(resp.status, route.label).toBe(403);
      expect(resp.bodyText, route.label).toMatch(/operator.*control-plane/i);
    }
    expect(registry.getSession(target.id)).toBeTruthy();
    expect(registry.getSession(target.id)?.title).toBe(originalTitle);
  });
});

describe("portal fallback is a virtual root, not employee authority", () => {
  it("breaks the config-spoof-to-self-approve chain at both the config write and virtual-root decision check", async () => {
    writeConfig();
    const blockedConfig = await call("PUT", "/api/config", { portal: { portalName: collidingPortalName } }, toolHeaders(worker));
    expect(blockedConfig.status).toBe(403);

    writeConfig(collidingPortalName);
    const root = approvalAuthority.resolveRootApprovalTarget() as { name: string; department: string | null; kind?: string } | null;
    expect(root).toBeTruthy();
    expect(root?.kind).toBe("virtual");
    expect(root?.name).not.toBe(collidingPortalName);

    const item = store.createWorkItem({ title: "collision-root approval", source: "human", status: "backlog" });
    const approval = approvals.requestApproval(item.id, { request: "Approve collision root", actor: "test" });
    expect(approval.approvalTarget).toBe(root?.name);
    expect(approval.approvalTarget).not.toBe(collidingPortalName);

    const workerDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, toolHeaders(worker));
    expect(workerDecision.status).toBe(403);

    const peerDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, toolHeaders(peer));
    expect(peerDecision.status).toBe(403);

    const operatorDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, { authorization: "Bearer test-token" });
    expect(operatorDecision.status).toBe(200);
    expect(operatorDecision.body.workItem).toMatchObject({ approvalState: "approved", approvalDecidedBy: "operator", approvalTarget: root?.name });
  });

  it("keeps a persisted virtual-root target virtual after an org employee later claims the same name", async () => {
    const driftRoot = "Drift Root";
    const driftFile = path.join(orgDir, "drift-root.yaml");
    fs.rmSync(driftFile, { force: true });
    writeConfig(driftRoot);

    const item = store.createWorkItem({ title: "org-drift virtual root", source: "human", status: "backlog" });
    const approval = approvals.requestApproval(item.id, { request: "Approve before drift", actor: "test" });
    expect(approval.approvalTarget).toBe(driftRoot);
    expect(approval.approvalTargetKind).toBe("virtual");

    fs.writeFileSync(
      driftFile,
      "name: Drift Root\ndisplayName: Drift Root\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Attempts to claim the persisted virtual root.\n",
    );
    const driftSession = registry.createSession({ engine: "codex", source: "web", sourceRef: "drift", title: "drift", employee: driftRoot });

    const employeeDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, toolHeaders(driftSession));
    expect(employeeDecision.status).toBe(403);

    const operatorDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, { authorization: "Bearer test-token" });
    expect(operatorDecision.status).toBe(200);
    expect(operatorDecision.body.workItem).toMatchObject({ approvalState: "approved", approvalDecidedBy: "operator", approvalTarget: driftRoot });

    fs.rmSync(driftFile, { force: true });
    writeConfig();
  });

  it("treats legacy NULL target-kind rows as non-employee-decidable after org drift", async () => {
    const legacyRoot = "Legacy Root";
    const legacyFile = path.join(orgDir, "legacy-root.yaml");
    fs.rmSync(legacyFile, { force: true });
    writeConfig(legacyRoot);

    const item = store.createWorkItem({ title: "legacy virtual root", source: "human", status: "backlog" });
    const approval = approvals.requestApproval(item.id, { request: "Approve before kind column existed", actor: "test" });
    expect(approval.approvalTarget).toBe(legacyRoot);
    expect(approval.approvalTargetKind).toBe("virtual");

    (await import("../../shared/db.js")).initDb().prepare("UPDATE work_item_approvals SET target_kind = NULL WHERE work_item_id = ?").run(approval.id);
    fs.writeFileSync(
      legacyFile,
      "name: Legacy Root\ndisplayName: Legacy Root\ndepartment: platform\nrank: employee\nreportsTo: platform-manager\nengine: codex\nmodel: gpt-5.5\npersona: Attempts to claim a legacy persisted approval target.\n",
    );
    const legacySession = registry.createSession({ engine: "codex", source: "web", sourceRef: "legacy-root", title: "legacy root", employee: legacyRoot });

    const employeeDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, toolHeaders(legacySession));
    expect(employeeDecision.status).toBe(403);

    const operatorDecision = await call("POST", `/api/work-items/${approval.id}/approval`, { decision: "approve" }, { authorization: "Bearer test-token" });
    expect(operatorDecision.status).toBe(200);

    fs.rmSync(legacyFile, { force: true });
    writeConfig();
  });
});
