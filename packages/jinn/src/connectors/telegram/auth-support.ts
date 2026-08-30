import * as pty from "node-pty";
import type { AuthProvider, RunCommand } from "./auth-providers.js";

export type AuthChatId = number | string;
export interface AuthMessage { userId: number | string; chatType: string; chatId: AuthChatId; messageId?: number | string; text: string; }
export interface AuthPty { write(data: string): void; kill(signal?: string): void; onData(handler: (data: string) => void): { dispose?: () => void } | void; onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose?: () => void } | void; }
export interface AuthSpawnOptions { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; }
export type SpawnPty = (file: string, args: readonly string[], options: AuthSpawnOptions) => AuthPty;
export interface AuthClock { now?: () => number; setTimeout(handler: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
export interface AuthLogger { warn?: (message: string) => void; error?: (message: string) => void; }
export interface AuthMenuCommand { command: string; description: string; }
export const AUTH_MENU_COMMANDS: AuthMenuCommand[] = [
  { command: "auth_claude", description: "Authenticate Claude" },
  { command: "auth_codex", description: "Authenticate Codex" },
  { command: "auth_status", description: "Show authentication status" },
  { command: "auth_cancel", description: "Cancel current authentication" },
];
export interface AuthBot { setMyCommands(commands: AuthMenuCommand[], options: { scope: { type: "chat"; chat_id: number } }): Promise<unknown>; }
export interface TelegramAuthOptions {
  bot: AuthBot;
  ownerUserIds: readonly number[];
  allowFrom: ReadonlySet<number> | null;
  env: NodeJS.ProcessEnv;
  flowTtlSeconds?: number;
  send: (chatId: AuthChatId, text: string) => void | Promise<void>;
  deleteMessage: (chatId: AuthChatId, messageId: number | string) => void | Promise<void>;
  spawnPty?: SpawnPty;
  runCommand?: RunCommand;
  clock?: AuthClock;
  logger: AuthLogger;
}
export interface ActiveFlow {
  key: string; generation: number; ownerId: number; provider: AuthProvider; chatId: AuthChatId; pty: AuthPty;
  timer?: unknown; discoveryTail: string; discoveredUrl?: string; discoveredCode?: string;
  urlSent: boolean; codeSent: boolean; invalidated: boolean;
  dataSubscription?: { dispose?: () => void }; exitSubscription?: { dispose?: () => void };
}
export type ProviderState = "authenticated" | "not authenticated" | "status unavailable";
export type AuthInputSource = "short-code" | "claude-callback";
export type AuthCommand =
  | { kind: "start"; provider: AuthProvider }
  | { kind: "status" } | { kind: "cancel" }
  | { kind: "input"; code: string; source: AuthInputSource }
  | { kind: "rejected" };

export const DEFAULT_FLOW_TTL_SECONDS = 600;
export const MAX_DISCOVERY_TAIL_BYTES = 4096;
const CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/;
const CLAUDE_CALLBACK_CODE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const CALLBACK_STATE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const CLAUDE_CALLBACK_INPUT_PATTERN = /^[A-Za-z0-9_-]{40,128}#[A-Za-z0-9_-]{16,256}$/;
const ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CALLBACK_URL_SHAPE_PATTERN = /^https?:\/\/[^\s"'<>]+\/callback(?:[?#\s]|$)/i;
const DISCOVERY_URL_PATTERN = /https:\/\/[^\s"'<>\x60]+(?=\s)/gi;
const DISCOVERY_CODE_PATTERN = /(?:device[\s_-]*code|user[\s_-]*code|one-time\s+code|verification\s+code|authentication\s+code|access\s+code)[\s\S]{0,120}?([A-Z0-9]{4}-[A-Z0-9]{4,5})(?=\s)/gi;
const AUTH_PREFIX_PATTERN = /^\/auth(?:_[a-z0-9-]+(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:[\s=:]|$)/i;
export const AUTH_PAYLOAD_PATTERN = /^\/auth(?:_[a-z0-9-]+(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:\s+\S|[=:]\s*\S)/i;
export const CLOCK: AuthClock = { now: () => Date.now(), setTimeout: (handler, delayMs) => setTimeout(handler, delayMs), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
export const DEFAULT_SPAWN_PTY: SpawnPty = (file, args, options) => pty.spawn(file, [...args], options);

const COMMANDS: Readonly<Record<string, AuthCommand>> = {
  claude: { kind: "start", provider: "claude" }, codex: { kind: "start", provider: "codex" }, status: { kind: "status" }, cancel: { kind: "cancel" },
};

export function isAuthCommandPrefix(text: string): boolean { return AUTH_PREFIX_PATTERN.test(text.trim()); }
export function parseAuthCommand(text: string): AuthCommand | null {
  const normalized = text.trim();
  if (!isAuthCommandPrefix(normalized)) return null;
  if (/\r|\n/.test(normalized)) return { kind: "rejected" };
  return parseMenuCommand(normalized) ?? parseLegacyCommand(normalized) ?? { kind: "rejected" };
}
function parseMenuCommand(normalized: string): AuthCommand | null {
  const menu = normalized.match(/^\/auth_([a-z-]+)(?:@[A-Za-z0-9_]+)?(?:(?:\s+|[=:]\s*)(\S+))?$/i);
  return menu ? parseCommand(menu[1].toLowerCase(), menu[2]) : null;
}
function parseLegacyCommand(normalized: string): AuthCommand | null {
  const legacy = normalized.match(/^\/auth(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!legacy) return null;
  const args = legacy[1]?.trim().split(/\s+/) ?? [];
  if (args.length === 1) return COMMANDS[args[0].toLowerCase()] ?? { kind: "rejected" };
  return args.length === 2 && args[0].toLowerCase() === "input" ? parseAuthInput(args[1]) ?? { kind: "rejected" } : { kind: "rejected" };
}
function parseCommand(action: string, value: string | undefined): AuthCommand {
  if (action === "input") return value ? parseAuthInput(value) ?? { kind: "rejected" } : { kind: "rejected" };
  const command = COMMANDS[action];
  return command && value === undefined ? command : { kind: "rejected" };
}
export function parseAuthInput(value: string): AuthCommand | null {
  if (isAuthCode(value)) return { kind: "input", code: value, source: "short-code" };
  const callbackCode = parseClaudeCallbackCode(value);
  return callbackCode ? { kind: "input", code: callbackCode, source: "claude-callback" } : null;
}
function isAuthCode(value: string): boolean { return CODE_PATTERN.test(value); }
export function isCallbackUrlShape(value: string): boolean {
  try { return new URL(value).pathname === "/callback"; }
  catch { return CALLBACK_URL_SHAPE_PATTERN.test(value); }
}
function parseClaudeCallbackCode(value: string): string | null {
  if (CLAUDE_CALLBACK_INPUT_PATTERN.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(host) || url.pathname !== "/callback") return null;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  return code && state && CLAUDE_CALLBACK_CODE_PATTERN.test(code) && CALLBACK_STATE_PATTERN.test(state) ? `${code}#${state}` : null;
}
export function ownerId(value: number | string): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}
export function resolveOwnerIds(configured: readonly number[], allowFrom: ReadonlySet<number> | null, logger: AuthLogger): number[] {
  const valid = configured.filter((id) => Number.isSafeInteger(id) && id > 0);
  for (const id of configured) if (!Number.isSafeInteger(id) || id <= 0) logger.warn?.(`[telegram] Ignoring invalid telegramAuth owner user id: ${String(id)}`);
  for (const id of valid) if (allowFrom && !allowFrom.has(id)) logger.warn?.(`[telegram] Excluding telegramAuth owner not present in allowFrom: ${id}`);
  return [...new Set(valid.filter((id) => !allowFrom || allowFrom.has(id)))];
}
export function appendUtf8Tail(current: string, data: string): string {
  const bytes = Buffer.concat([Buffer.from(current), Buffer.from(data)]);
  if (bytes.length <= MAX_DISCOVERY_TAIL_BYTES) return bytes.toString("utf8");
  let start = bytes.length - MAX_DISCOVERY_TAIL_BYTES;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
export function extractDiscovery(text: string, final = false): { url?: string; code?: string } {
  const normalized = text.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
  const source = final ? normalized + "\n" : normalized;
  const urls = [...source.matchAll(DISCOVERY_URL_PATTERN)];
  const url = urls.at(-1)?.[0]?.replace(/[.,!?;:)\]}]+$/g, "");
  const codeSource = source.replace(DISCOVERY_URL_PATTERN, " ");
  let code: string | undefined;
  for (const match of codeSource.matchAll(DISCOVERY_CODE_PATTERN)) if (isAuthCode(match[1])) code = match[1];
  return { url, code };
}
export function flowKey(owner: number, provider: AuthProvider): string { return `${owner}:${provider}`; }
