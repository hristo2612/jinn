import DES from 'des.js';

export function reverseBits(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
  return r & 0xff;
}

/**
 * VNC "VNC Authentication" (security type 2) challenge response.
 * Key = first 8 bytes of password (NUL-padded), each byte bit-reversed.
 * Cipher = DES-ECB, no padding, applied to the 16-byte challenge (two blocks).
 * Node 24 / OpenSSL 3 removed legacy DES, so we use the pure-JS des.js.
 */
export function vncDesResponse(password: string, challenge: Buffer): Buffer {
  const pw = Buffer.from(password, 'latin1');
  const key = Buffer.alloc(8, 0);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(i < pw.length ? pw[i] : 0);
  const des = DES.DES.create({ type: 'encrypt', key });
  // des.js processes ECB block-by-block with no padding; challenge is 16 bytes.
  return Buffer.from(des.update(challenge));
}
