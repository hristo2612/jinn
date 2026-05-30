import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const rfbInstances: any[] = [];
vi.mock('@novnc/novnc', () => ({
  default: class { _events: any = {};
    constructor(public target: any, public url: string) { rfbInstances.push(this); }
    addEventListener(e: string, cb: any) { this._events[e] = cb; }
    disconnect() { this.disconnected = true; }
    disconnected = false;
  },
}));

import { TakeoverModal } from '../takeover-modal';

beforeEach(() => { rfbInstances.length = 0; });

describe('TakeoverModal', () => {
  it('builds a wss assist vnc url and connects', async () => {
    render(<TakeoverModal reqId="r9" onResume={() => {}} onClose={() => {}} />);
    // RFB constructed lazily on mount
    await Promise.resolve();
    expect(rfbInstances.length).toBe(1);
    expect(rfbInstances[0].url).toMatch(/\/api\/assist\/r9\/vnc$/);
    expect(rfbInstances[0].url).toMatch(/^wss?:\/\//);
  });

  it('Resume agent disconnects and calls onResume', async () => {
    const onResume = vi.fn();
    render(<TakeoverModal reqId="r9" onResume={onResume} onClose={() => {}} />);
    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: /resume agent/i }));
    expect(onResume).toHaveBeenCalled();
    expect(rfbInstances[0].disconnected).toBe(true);
  });
});
