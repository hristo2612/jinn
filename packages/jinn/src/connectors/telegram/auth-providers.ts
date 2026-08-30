import { execFile as nodeExecFile } from "node:child_process";
import type { AuthInputSource } from "./auth-support.js";

export type AuthProvider = "claude" | "codex";

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

const STATUS_TIMEOUT_MS = 15_000;

export function runCommand(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    nodeExecFile(
      file,
      [...args],
      {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        const failure = error as (Error & { code?: unknown; status?: unknown }) | null;
        resolve({
          stdout: String(stdout ?? ""),
          exitCode: !failure ? 0 : typeof failure.code === "number" ? failure.code : typeof failure.status === "number" ? failure.status : 1,
        });
      },
    );
  });
}

export interface ProviderDefinition {
  label: string;
  login: readonly [file: string, args: readonly string[]];
  instructions: string;
  acceptedInputSources: readonly AuthInputSource[];
  invalidInputMessage: string;
  status(run: RunCommand): Promise<boolean>;
}

export const PROVIDERS: Record<AuthProvider, ProviderDefinition> = {
  claude: {
    label: "Claude",
    login: ["claude", ["auth", "login", "--claudeai"]],
    instructions: "Claude authentication started. Follow the instructions below. Send the device code here. If Claude shows a browser value as code#state, send that here. If Claude redirects to a localhost /callback URL, send the full URL here.",
    acceptedInputSources: ["short-code", "claude-callback"],
    invalidInputMessage: "A Claude callback URL can only be used with /auth_claude.",
    async status(run) {
      const result = await run("claude", ["auth", "status", "--json"], STATUS_TIMEOUT_MS);
      if (result.exitCode !== 0) return false;
      const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn !== "boolean") throw new Error("provider authentication status could not be read");
      return parsed.loggedIn;
    },
  },
  codex: {
    label: "Codex",
    login: ["codex", ["login", "--device-auth"]],
    instructions: "Codex authentication started. The bot will send the 9-character device code below; enter it in the browser. If it does not appear, send the code here.",
    acceptedInputSources: ["short-code"],
    invalidInputMessage: "A Codex callback URL is not valid here. Send the 9-character device code shown in the browser.",
    async status(run) {
      return (await run("codex", ["login", "status"], STATUS_TIMEOUT_MS)).exitCode === 0;
    },
  },
};
