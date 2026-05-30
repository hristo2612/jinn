import type { ServerResponse } from 'node:http';
import type { AssistRegistry } from './assist.js';
import type { MessageMedia } from '../sessions/registry.js';

export interface AssistRouteCtx {
  assist: AssistRegistry;
  emit: (event: string, payload: unknown) => void;
  insertMessage: (sessionId: string, role: string, content: string, media?: MessageMedia[]) => string;
  connectors: Map<string, { sendMessage: (t: { channel: string }, text: string) => Promise<unknown> }>;
}

function send(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function matchSegments(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = pathname.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

/**
 * Human-in-the-loop assist routes. Returns true if it handled the route.
 * Kept as a focused module so api.ts only delegates.
 */
export async function handleAssistRoutes(
  method: string,
  pathname: string,
  body: { reason?: unknown; url?: unknown } | undefined,
  res: ServerResponse,
  ctx: AssistRouteCtx,
): Promise<boolean> {
  // POST /api/sessions/:id/assist/request
  let m = matchSegments('/api/sessions/:id/assist/request', pathname);
  if (m && method === 'POST') {
    const reason = String(body?.reason ?? '').trim() || 'Agent needs help';
    const url = typeof body?.url === 'string' ? body.url : undefined;
    const rec = ctx.assist.create({ sessionId: m.id, reason, url });
    const card: MessageMedia = { type: 'assist-request', url: url ?? '', reqId: rec.id, reason, status: 'pending' };
    ctx.insertMessage(m.id, 'assistant', `🙋 Help needed: ${reason}`, [card]);
    ctx.emit('session:assist-requested', rec);
    const slack = ctx.connectors.get('slack');
    if (slack) {
      slack
        .sendMessage(
          { channel: '#work-items' },
          `🙋 *Help needed* in session \`${m.id}\`\n> ${reason}${url ? `\n${url}` : ''}\nOpen the chat to take control.`,
        )
        .catch(() => {
          /* alert best-effort */
        });
    }
    send(res, { reqId: rec.id, status: rec.status }, 201);
    return true;
  }

  // POST /api/assist/:reqId/resolve
  m = matchSegments('/api/assist/:reqId/resolve', pathname);
  if (m && method === 'POST') {
    const rec = ctx.assist.get(m.reqId);
    if (!rec) {
      send(res, { error: 'not found' }, 404);
      return true;
    }
    ctx.assist.resolve(m.reqId);
    ctx.emit('session:assist-resolved', { reqId: m.reqId, sessionId: rec.sessionId });
    send(res, { status: 'resolved' });
    return true;
  }

  // GET /api/assist/:reqId
  m = matchSegments('/api/assist/:reqId', pathname);
  if (m && method === 'GET') {
    const rec = ctx.assist.get(m.reqId);
    if (!rec) {
      send(res, { error: 'not found' }, 404);
      return true;
    }
    send(res, { status: rec.status, reason: rec.reason, url: rec.url, sessionId: rec.sessionId });
    return true;
  }

  return false;
}
