import { describe, it, expect } from 'vitest';
import { vncDesResponse, reverseBits } from '../rfb-auth.js';

describe('vnc type-2 DES auth', () => {
  it('reverses bits in a byte', () => {
    expect(reverseBits(0x01)).toBe(0x80);
    expect(reverseBits(0xff)).toBe(0xff);
    expect(reverseBits(0x73)).toBe(0xce); // 's'
  });

  it('computes the canonical VNC response (known-answer vector)', () => {
    const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const resp = vncDesResponse('secret12', challenge);
    expect(resp.toString('hex')).toBe('adcd997f8e16fee575e973f93c2b62b4');
  });

  it('pads/truncates the password to 8 bytes', () => {
    // shorter password still yields a 16-byte response
    const challenge = Buffer.alloc(16, 0);
    expect(vncDesResponse('ab', challenge).length).toBe(16);
  });
});
