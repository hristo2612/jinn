import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JINN_HOME } from '../shared/paths.js';

/**
 * Resolve the 8-char legacy VNC password used by the takeover proxy to
 * authenticate to screensharingd. Kept SERVER-SIDE only (never sent to the
 * browser — the proxy presents security-type None to noVNC).
 *
 * Priority: env JINN_VNC_PASSWORD, then ~/.jinn/secrets/api-keys.json `vncPassword`.
 * Truncated to 8 chars (legacy VNC limit). Returns null if unset.
 */
export function loadVncPassword(): string | null {
  if (process.env.JINN_VNC_PASSWORD) return process.env.JINN_VNC_PASSWORD.slice(0, 8);
  try {
    const p = path.join(JINN_HOME, 'secrets', 'api-keys.json');
    const j = JSON.parse(readFileSync(p, 'utf8')) as { vncPassword?: unknown };
    return typeof j.vncPassword === 'string' && j.vncPassword.length > 0 ? j.vncPassword.slice(0, 8) : null;
  } catch {
    return null;
  }
}
