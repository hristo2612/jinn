import net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { vncDesResponse } from './rfb-auth.js';

export interface RfbBridgeOpts {
  clientReadable: Readable; // bytes from noVNC
  clientWritable: Writable; // bytes to noVNC
  vncHost: string;
  vncPort: number;
  password: string;
}

/**
 * Buffers all bytes from a stream and serves exact-length reads from the buffer.
 * Avoids stream.unshift() (fragile in flowing mode). After the handshake, call
 * stop() to detach the listener and recover any bytes already received so they
 * can be forwarded into the transparent pipe.
 */
class ByteReader {
  private buf = Buffer.alloc(0);
  private want: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private stopped = false;
  private readonly onData = (d: Buffer) => {
    this.buf = Buffer.concat([this.buf, d]);
    this.flush();
  };
  private readonly onErr = (e: Error) => {
    this.want?.reject(e);
    this.want = null;
  };
  private readonly onEnd = () => {
    if (this.want) {
      this.want.reject(new Error('stream ended before reading enough bytes'));
      this.want = null;
    }
  };

  constructor(private stream: Readable) {
    stream.on('data', this.onData);
    stream.once('error', this.onErr);
    stream.once('end', this.onEnd);
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(new Error('reader stopped'));
      this.want = { n, resolve, reject };
      this.flush();
    });
  }

  private flush(): void {
    if (this.want && this.buf.length >= this.want.n) {
      const { n, resolve } = this.want;
      this.want = null;
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      resolve(out);
    }
  }

  /** Detach and return any bytes received but not yet consumed. */
  stop(): Buffer {
    if (this.stopped) return Buffer.alloc(0);
    this.stopped = true;
    this.stream.off('data', this.onData);
    this.stream.off('error', this.onErr);
    this.stream.off('end', this.onEnd);
    return this.buf;
  }
}

/**
 * RFB man-in-the-middle: authenticates to Apple screensharingd with legacy
 * VNC security type 2 (DES) using a SERVER-SIDE password, while presenting
 * security-type None to the noVNC client — so the password never reaches the
 * browser. After both handshakes complete it pipes transparently.
 *
 * Resolves once the transparent pipe is wired (handshakes done).
 */
export async function runRfbBridge(opts: RfbBridgeOpts): Promise<void> {
  const server = net.connect(opts.vncPort, opts.vncHost);
  await new Promise<void>((res, rej) => {
    server.once('connect', res);
    server.once('error', rej);
  });

  const serverReader = new ByteReader(server);
  const clientReader = new ByteReader(opts.clientReadable);

  try {
    // ── Server side: authenticate with type 2 ────────────────────
    await serverReader.read(12); // "RFB 003.889\n"
    server.write(Buffer.from('RFB 003.008\n', 'ascii'));
    const nTypes = (await serverReader.read(1))[0];
    const types = await serverReader.read(nTypes);
    if (!types.includes(2)) throw new Error('screensharingd does not offer VNC type-2 auth (enable legacy VNC)');
    server.write(Buffer.from([2])); // choose type 2
    const challenge = await serverReader.read(16);
    server.write(vncDesResponse(opts.password, challenge));
    const secResult = await serverReader.read(4);
    if (secResult.readUInt32BE(0) !== 0) throw new Error('VNC server auth failed (wrong password?)');
    server.write(Buffer.from([1])); // ClientInit shared=1
    const serverInitHead = await serverReader.read(24); // w,h,pixelformat(16),namelen(4)
    const nameLen = serverInitHead.readUInt32BE(20);
    const name = nameLen > 0 ? await serverReader.read(nameLen) : Buffer.alloc(0);
    const fullServerInit = Buffer.concat([serverInitHead, name]);

    // ── Client side: version → None → SecurityResult → ServerInit ─
    opts.clientWritable.write(Buffer.from('RFB 003.008\n', 'ascii'));
    await clientReader.read(12); // client version
    opts.clientWritable.write(Buffer.from([1, 1])); // one security type: None(1)
    await clientReader.read(1); // client picks 1
    opts.clientWritable.write(Buffer.from([0, 0, 0, 0])); // SecurityResult OK (RFB 3.8 semantics)
    await clientReader.read(1); // client ClientInit (shared flag)
    opts.clientWritable.write(fullServerInit);
  } catch (err) {
    serverReader.stop();
    clientReader.stop();
    try {
      server.destroy();
    } catch {
      /* ignore */
    }
    throw err;
  }

  // ── Transparent pipe both ways ───────────────────────────────
  // Recover any bytes that arrived during the handshake and forward them first,
  // then wire the live pipe.
  const serverLeftover = serverReader.stop();
  const clientLeftover = clientReader.stop();
  if (clientLeftover.length) server.write(clientLeftover);
  if (serverLeftover.length) opts.clientWritable.write(serverLeftover);

  opts.clientReadable.on('data', (d) => {
    server.write(d);
  });
  server.on('data', (d) => {
    opts.clientWritable.write(d);
  });
  const teardown = () => {
    try {
      server.destroy();
    } catch {
      /* ignore */
    }
  };
  server.on('close', teardown);
  server.on('error', teardown);
  opts.clientReadable.on('close', teardown);
  opts.clientReadable.on('error', teardown);
}
