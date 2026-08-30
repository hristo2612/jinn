import { PROVIDERS, runCommand, type AuthProvider, type RunCommand } from "./auth-providers.js";
import { logger } from "../../shared/logger.js";
import {
  AUTH_MENU_COMMANDS, AUTH_PAYLOAD_PATTERN, CLOCK, DEFAULT_FLOW_TTL_SECONDS, DEFAULT_SPAWN_PTY,
  appendUtf8Tail, extractDiscovery, flowKey, isCallbackUrlShape, ownerId, parseAuthCommand,
  parseAuthInput, resolveOwnerIds, type ActiveFlow, type AuthBot, type AuthChatId, type AuthClock,
  type AuthCommand, type AuthLogger, type AuthMessage, type AuthPty, type ProviderState,
  type SpawnPty, type TelegramAuthOptions,
} from "./auth-support.js";
export * from "./auth-support.js";

const AUTHENTICATION_FAILURE_PATTERN = /\binteractive turn failed:\s*authentication_failed\b|\b(?:claude|codex)(?:\s+cli)?\s+(?:authentication failed|is not authenticated|is not logged in)\b|\b(?:codex|claude)\s+(?:login required|login needed)\b/i;
const AUTH_LOGIN_PROMPT = "Provider authentication is required. Check `/auth_status`, then use `/auth_claude` or `/auth_codex` to sign in.";

interface ConnectorAuthBot extends AuthBot {
  sendMessage(chatId: string, text: string): Promise<unknown>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
}

export function createTelegramAuth(
  bot: ConnectorAuthBot,
  config: { ownerUserIds?: readonly number[]; flowTtlSeconds?: number },
  allowFrom: ReadonlySet<number> | null,
  env: NodeJS.ProcessEnv = process.env,
): TelegramAuth | undefined {
  const ownerUserIds = resolveOwnerIds(config.ownerUserIds ?? [], allowFrom, logger);
  if (ownerUserIds.length === 0) {
    logger.error?.("[telegram-auth] enabled but no owner user IDs resolved");
    return undefined;
  }
  return new TelegramAuth({
    bot,
    ownerUserIds,
    allowFrom: null,
    env,
    flowTtlSeconds: config.flowTtlSeconds,
    send: async (chatId, text) => { await bot.sendMessage(String(chatId), text); },
    deleteMessage: async (chatId, messageId) => { await bot.deleteMessage(String(chatId), Number(messageId)); },
    logger,
  });
}

export class TelegramAuth {
  private readonly bot: AuthBot;
  private readonly owners: ReadonlySet<number>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sendMessage: TelegramAuthOptions["send"];
  private readonly deleteMessage: TelegramAuthOptions["deleteMessage"];
  private readonly spawnPty: SpawnPty;
  private readonly run: RunCommand;
  private readonly clock: AuthClock;
  private readonly logger: AuthLogger;
  private readonly flowTtlMs: number;
  private readonly active = new Map<string, ActiveFlow>();
  private readonly pending = new Set<ActiveFlow>();
  private readonly generations = new Map<string, number>();
  private stopped = false;

  constructor(options: TelegramAuthOptions) {
    this.bot = options.bot;
    this.owners = new Set(resolveOwnerIds(options.ownerUserIds, options.allowFrom, options.logger));
    this.env = options.env;
    this.sendMessage = options.send;
    this.deleteMessage = options.deleteMessage;
    this.spawnPty = options.spawnPty ?? DEFAULT_SPAWN_PTY;
    this.run = options.runCommand ?? runCommand;
    this.clock = options.clock ?? CLOCK;
    this.logger = options.logger;
    this.flowTtlMs = (options.flowTtlSeconds && options.flowTtlSeconds > 0 ? options.flowTtlSeconds : DEFAULT_FLOW_TTL_SECONDS) * 1000;
  }

  start(): void {
    if (this.stopped) return;
    for (const owner of this.owners) {
      void Promise.resolve()
        .then(() => this.bot.setMyCommands(AUTH_MENU_COMMANDS, { scope: { type: "chat", chat_id: owner } }))
        .catch(() => this.logger.warn?.(`[telegram] Could not publish auth command menu for owner ${owner}`));
    }
  }

  async handle(message: AuthMessage): Promise<boolean> {
    const raw = message.text.trim();
    const command = parseAuthCommand(raw);
    const input = parseAuthInput(raw);
    const id = ownerId(message.userId);
    const callbackUrl = isCallbackUrlShape(raw);
    if (!command && input && !this.hasActiveFlow(id) && !callbackUrl) return false;
    const owner = id !== null && this.owners.has(id);
    const sensitive = Boolean(input) || AUTH_PAYLOAD_PATTERN.test(raw) || callbackUrl;
    const warning = await this.scrub(message, sensitive, owner);

    return command
      ? this.handleCommand(message, command, id, owner, warning)
      : this.handleInput({ message, input, id, owner, sensitive, warning });
  }

  private async handleInput(options: { message: AuthMessage; input: AuthCommand | null; id: number | null; owner: boolean; sensitive: boolean; warning: string }): Promise<boolean> {
    const { message, input, id, owner, sensitive, warning } = options;
    if (!sensitive) return false;
    if (!owner || !input || input.kind !== "input" || id === null) return true;
    if (message.chatType !== "private") {
      await this.safeSend(message.chatId, "Authentication commands are available only in a private chat.", warning);
      return true;
    }
    await this.writeCode(id, input, message.chatId, warning);
    return true;
  }

  private async handleCommand(message: AuthMessage, command: AuthCommand, id: number | null, owner: boolean, warning: string): Promise<boolean> {
    if (!owner || id === null) return true;
    if (message.chatType !== "private") {
      await this.safeSend(message.chatId, "Authentication commands are available only in a private chat.", warning);
      return true;
    }
    if (command.kind === "rejected") {
      await this.safeSend(message.chatId, "Unsupported authentication command.", warning);
      return true;
    }
    await this.dispatch(id, message.chatId, command, warning);
    return true;
  }

  async handleIncoming(userId: number | string, chatType: string, chatId: AuthChatId, messageId: number | string | undefined, text: string): Promise<boolean> {
    return this.handle({ userId, chatType, chatId, messageId, text });
  }

  async scrubExplicitPayload(message: AuthMessage): Promise<void> {
    if (!AUTH_PAYLOAD_PATTERN.test(message.text.trim())) return;
    await this.scrub(message, true, false);
  }

  decorateReply(context: { chatType?: string; userId?: number | string } | undefined, text: string): string {
    if (!context || context.chatType !== "private" || !AUTHENTICATION_FAILURE_PATTERN.test(text)) return text;
    const id = ownerId(context.userId ?? "");
    return id !== null && this.owners.has(id) ? `${text}\n\n${AUTH_LOGIN_PROMPT}` : text;
  }

  async status(owner: number, chatId: AuthChatId, warning = ""): Promise<void> {
    const states = await Promise.all((Object.keys(PROVIDERS) as AuthProvider[]).map(async (provider) => `${PROVIDERS[provider].label}: ${await this.providerState(provider)}.`));
    await this.safeSend(chatId, `${this.activeStatus(owner)}\n${states.join("\n")}`, warning);
  }

  private hasActiveFlow(owner: number | null): boolean {
    return owner !== null && [...this.active.values()].some((flow) => flow.ownerId === owner);
  }

  stop(): void {
    this.stopped = true;
    for (const flow of this.active.values()) this.clear(flow, true);
    for (const flow of this.pending) flow.invalidated = true;
    this.pending.clear();
  }

  private async dispatch(owner: number, chatId: AuthChatId, command: AuthCommand, warning: string): Promise<void> {
    if (command.kind === "start") return this.startFlow(owner, command.provider, chatId, warning);
    if (command.kind === "status") return this.status(owner, chatId, warning);
    if (command.kind === "cancel") return this.cancel(owner, chatId, warning);
    if (command.kind === "input") return this.writeCode(owner, command, chatId, warning);
  }

  private async startFlow(owner: number, provider: AuthProvider, chatId: AuthChatId, warning: string): Promise<void> {
    if (this.stopped) return;
    const key = flowKey(owner, provider);
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const previous = this.active.get(key);
    if (previous) this.clear(previous, true);
    const [file, args] = PROVIDERS[provider].login;
    let child: AuthPty;
    try {
      child = this.spawnPty(file, args, { name: "xterm-256color", cols: 120, rows: 40, cwd: process.cwd(), env: this.env });
    } catch {
      this.logger.error?.("[telegram-auth] failed to start provider process");
      await this.safeSend(chatId, `${PROVIDERS[provider].label} authentication failed to start.`, warning);
      return;
    }
    const flow: ActiveFlow = { key, generation, ownerId: owner, provider, chatId, pty: child, discoveryTail: "", urlSent: false, codeSent: false, invalidated: false };
    this.active.set(key, flow);
    this.attach(flow);
    await this.safeSend(chatId, PROVIDERS[provider].instructions, warning);
    if (this.stopped && this.active.get(key) === flow) this.clear(flow, true);
  }

  private attach(flow: ActiveFlow): void {
    const data = flow.pty.onData((chunk) => {
      if (!this.isCurrent(flow)) return;
      flow.discoveryTail = appendUtf8Tail(flow.discoveryTail, chunk);
      const discovery = extractDiscovery(flow.discoveryTail);
      this.updateDiscovery(flow, discovery);
      const lines = this.discoveryLines(flow);
      if (lines.length > 1) void this.safeSend(flow.chatId, lines.join("\n"));
    });
    const exit = flow.pty.onExit((event) => void this.finish(flow, event.exitCode));
    flow.dataSubscription = data && typeof data === "object" ? data : undefined;
    flow.exitSubscription = exit && typeof exit === "object" ? exit : undefined;
    flow.timer = this.clock.setTimeout(() => this.timeout(flow), this.flowTtlMs);
  }

  private async finish(flow: ActiveFlow, exitCode: number): Promise<void> {
    if (!this.isCurrentGeneration(flow)) return;
    this.updateDiscovery(flow, extractDiscovery(flow.discoveryTail, true));
    const lines = this.discoveryLines(flow);
    if (lines.length > 1) await this.safeSend(flow.chatId, lines.join("\n"));
    this.detach(flow, false);
    if (exitCode !== 0) { await this.safeSend(flow.chatId, `${PROVIDERS[flow.provider].label} authentication failed.`); return; }
    this.pending.add(flow);
    let verified = false;
    try { verified = await PROVIDERS[flow.provider].status(this.run); } catch { verified = false; }
    finally { this.pending.delete(flow); }
    if (!this.isCurrentGeneration(flow)) return;
    await this.safeSend(flow.chatId, verified ? `${PROVIDERS[flow.provider].label} authentication succeeded: authenticated.` : `${PROVIDERS[flow.provider].label} authentication failed: could not be verified. Try again with /auth_${flow.provider}.`);
  }

  private async providerState(provider: AuthProvider): Promise<ProviderState> {
    try { return await PROVIDERS[provider].status(this.run) ? "authenticated" : "not authenticated"; } catch { return "status unavailable"; }
  }

  private activeStatus(owner: number): string {
    const providers = [...this.active.values()].filter((flow) => flow.ownerId === owner).map((flow) => PROVIDERS[flow.provider].label).sort();
    return providers.length === 0 ? "No authentication flow is active." : `Active authentication flows: ${providers.join(", ")}.`;
  }

  private async cancel(owner: number, chatId: AuthChatId, warning: string): Promise<void> {
    const flows = [...this.active.values()].filter((flow) => flow.ownerId === owner);
    const pending = [...this.pending].filter((flow) => flow.ownerId === owner);
    if (flows.length === 0 && pending.length === 0) { await this.safeSend(chatId, "No authentication flow is active.", warning); return; }
    for (const flow of flows) this.clear(flow, true);
    for (const flow of pending) flow.invalidated = true;
    await this.safeSend(chatId, "Authentication cancelled.", warning);
  }

  private async writeCode(owner: number, input: Extract<AuthCommand, { kind: "input" }>, chatId: AuthChatId, warning: string): Promise<void> {
    const flows = [...this.active.values()].filter((flow) => flow.ownerId === owner);
    if (flows.length === 0) { await this.safeSend(chatId, "No authentication flow is active.", warning); return; }
    if (flows.length > 1) { await this.safeSend(chatId, "Authentication input is ambiguous while multiple providers are active.", warning); return; }
    const provider = PROVIDERS[flows[0].provider];
    if (!provider.acceptedInputSources.includes(input.source)) { await this.safeSend(chatId, provider.invalidInputMessage, warning); return; }
    try { flows[0].pty.write(`${input.code}\r`); if (warning) await this.safeSend(chatId, warning); }
    catch { this.logger.warn?.("[telegram-auth] failed to write authentication input"); await this.safeSend(chatId, "Authentication input failed.", warning); }
  }

  private discoveryLines(flow: ActiveFlow): string[] {
    const lines = ["Continue authentication:"];
    if (flow.discoveredUrl && !flow.urlSent) { flow.urlSent = true; lines.push(flow.discoveredUrl); }
    if (flow.discoveredCode && !flow.codeSent) { flow.codeSent = true; lines.push(`Device code: ${flow.discoveredCode}`); }
    return lines;
  }

  private updateDiscovery(flow: ActiveFlow, discovery: { url?: string; code?: string }): void {
    if (discovery.url && discovery.url !== flow.discoveredUrl) {
      flow.discoveredUrl = discovery.url;
      flow.urlSent = false;
    }
    if (discovery.code && discovery.code !== flow.discoveredCode) {
      flow.discoveredCode = discovery.code;
      flow.codeSent = false;
    }
  }

  private timeout(flow: ActiveFlow): void {
    if (!this.isCurrent(flow)) return;
    this.clear(flow, true);
    void this.safeSend(flow.chatId, `Authentication timed out. Try again with /auth_${flow.provider}.`);
  }

  private clear(flow: ActiveFlow, kill: boolean): void {
    if (this.active.get(flow.key) !== flow) return;
    this.detach(flow, true);
    if (kill) try { flow.pty.kill(); } catch { this.logger.warn?.("[telegram-auth] failed to stop provider process"); }
  }

  private detach(flow: ActiveFlow, invalidate: boolean): void {
    if (this.active.get(flow.key) !== flow) return;
    this.active.delete(flow.key);
    if (invalidate) flow.invalidated = true;
    if (flow.timer !== undefined) this.clock.clearTimeout(flow.timer);
    flow.timer = undefined;
    flow.dataSubscription?.dispose?.();
    flow.exitSubscription?.dispose?.();
  }

  private isCurrent(flow: ActiveFlow): boolean { return this.active.get(flow.key) === flow && !flow.invalidated && this.generations.get(flow.key) === flow.generation; }
  private isCurrentGeneration(flow: ActiveFlow): boolean { return !flow.invalidated && this.generations.get(flow.key) === flow.generation; }

  private async scrub(message: AuthMessage, sensitive: boolean, owner: boolean): Promise<string> {
    if (!sensitive || message.messageId === undefined) return "";
    try { await this.deleteMessage(message.chatId, message.messageId); return ""; }
    catch { this.logger.warn?.("[telegram-auth] unable to delete sensitive auth message"); return owner ? "Warning: the message could not be deleted. Remove it manually." : ""; }
  }

  private async safeSend(chatId: AuthChatId, text: string, warning = ""): Promise<void> {
    try { await this.sendMessage(chatId, warning ? `${text}\n${warning}` : text); } catch { this.logger.warn?.("[telegram-auth] unable to send auth update"); }
  }
}
