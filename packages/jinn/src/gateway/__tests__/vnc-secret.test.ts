import { describe, it, expect, afterEach } from 'vitest';
import { loadVncPassword } from '../vnc-secret.js';

const ORIG = process.env.JINN_VNC_PASSWORD;
afterEach(() => {
  if (ORIG === undefined) delete process.env.JINN_VNC_PASSWORD;
  else process.env.JINN_VNC_PASSWORD = ORIG;
});

describe('loadVncPassword', () => {
  it('prefers the env var', () => {
    process.env.JINN_VNC_PASSWORD = 'abc123';
    expect(loadVncPassword()).toBe('abc123');
  });

  it('truncates to 8 chars (legacy VNC limit)', () => {
    process.env.JINN_VNC_PASSWORD = 'thisistoolong';
    expect(loadVncPassword()).toBe('thisisto');
  });
});
