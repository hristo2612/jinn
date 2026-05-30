import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AssistRegistry } from '../assist.js';
import { handleAssistRoutes } from '../assist-routes.js';

function mockRes() {
  return {
    statusCode: 200,
    body: '' as string,
    writeHead(s: number) {
      this.statusCode = s;
      return this;
    },
    end(b?: string) {
      if (b) this.body = b;
      return this;
    },
  } as any;
}

describe('assist routes', () => {
  let assist: AssistRegistry;
  let emit: ReturnType<typeof vi.fn>;
  let insertMessage: ReturnType<typeof vi.fn>;
  let slackSend: ReturnType<typeof vi.fn>;
  let ctx: any;
  beforeEach(() => {
    assist = new AssistRegistry();
    emit = vi.fn();
    insertMessage = vi.fn(() => 'msg1');
    slackSend = vi.fn(async () => 'ts');
    ctx = { assist, emit, insertMessage, connectors: new Map([['slack', { sendMessage: slackSend }]]) };
  });

  it('POST request creates record, persists card, emits, pings slack', async () => {
    const res = mockRes();
    const handled = await handleAssistRoutes(
      'POST',
      '/api/sessions/s1/assist/request',
      { reason: 'captcha', url: 'http://x' },
      res,
      ctx,
    );
    expect(handled).toBe(true);
    const out = JSON.parse(res.body);
    expect(out.status).toBe('pending');
    expect(assist.get(out.reqId)).toBeTruthy();
    expect(insertMessage).toHaveBeenCalledWith(
      's1',
      'assistant',
      expect.any(String),
      [expect.objectContaining({ type: 'assist-request', reqId: out.reqId, status: 'pending' })],
    );
    expect(emit).toHaveBeenCalledWith('session:assist-requested', expect.objectContaining({ id: out.reqId }));
    expect(slackSend).toHaveBeenCalled();
  });

  it('POST request defaults reason when missing', async () => {
    const res = mockRes();
    await handleAssistRoutes('POST', '/api/sessions/s1/assist/request', {}, res, ctx);
    const out = JSON.parse(res.body);
    expect(assist.get(out.reqId)!.reason).toBe('Agent needs help');
  });

  it('POST resolve flips status and emits', async () => {
    const rec = assist.create({ sessionId: 's1', reason: 'x' });
    const res = mockRes();
    const handled = await handleAssistRoutes('POST', `/api/assist/${rec.id}/resolve`, {}, res, ctx);
    expect(handled).toBe(true);
    expect(assist.get(rec.id)!.status).toBe('resolved');
    expect(emit).toHaveBeenCalledWith('session:assist-resolved', { reqId: rec.id, sessionId: 's1' });
  });

  it('POST resolve unknown reqId returns 404', async () => {
    const res = mockRes();
    await handleAssistRoutes('POST', '/api/assist/nope/resolve', {}, res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('GET returns status', async () => {
    const rec = assist.create({ sessionId: 's1', reason: 'login', url: 'http://y' });
    const res = mockRes();
    const handled = await handleAssistRoutes('GET', `/api/assist/${rec.id}`, undefined, res, ctx);
    expect(handled).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'pending', reason: 'login', sessionId: 's1' });
  });

  it('GET unknown reqId returns 404', async () => {
    const res = mockRes();
    await handleAssistRoutes('GET', '/api/assist/nope', undefined, res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('returns false for non-assist paths', async () => {
    const res = mockRes();
    expect(await handleAssistRoutes('GET', '/api/status', undefined, res, ctx)).toBe(false);
  });
});
