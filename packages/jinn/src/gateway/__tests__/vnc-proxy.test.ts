import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { runRfbBridge } from '../vnc-proxy.js';
import { vncDesResponse } from '../rfb-auth.js';

const PW = 'secret12';
const CHALLENGE = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const SERVER_INIT = (() => {
  // width=2, height=2, 16-byte pixelformat, name-length=1, name "x"
  const b = Buffer.alloc(2 + 2 + 16 + 4 + 1);
  b.writeUInt16BE(2, 0);
  b.writeUInt16BE(2, 2);
  b.writeUInt32BE(1, 20);
  b.write('x', 24, 'ascii');
  return b;
})();

function expectByte(got: number, want: number) {
  if (got !== want) throw new Error(`byte ${got}!=${want}`);
}
function expectEqual(a: Buffer, b: Buffer) {
  if (Buffer.compare(a, b) !== 0) throw new Error(`buf mismatch ${a.toString('hex')} != ${b.toString('hex')}`);
}

/** Fake screensharingd: 003.889 → types [30,33,36,35,2] → challenge → SecurityResult ok → read ClientInit → ServerInit. */
function fakeServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let stage = 0;
      sock.write(Buffer.from('RFB 003.889\n', 'ascii'));
      sock.on('data', (d) => {
        if (stage === 0) {
          // got client version
          sock.write(Buffer.from([5, 30, 33, 36, 35, 2]));
          stage = 1;
          return;
        }
        if (stage === 1) {
          expectByte(d[0], 2); // chose type 2
          sock.write(CHALLENGE);
          stage = 2;
          return;
        }
        if (stage === 2) {
          expectEqual(d.subarray(0, 16), vncDesResponse(PW, CHALLENGE));
          sock.write(Buffer.from([0, 0, 0, 0])); // SecurityResult OK
          stage = 3;
          return;
        }
        if (stage === 3) {
          // got ClientInit (1-byte shared flag)
          sock.write(SERVER_INIT);
          stage = 4;
          return;
        }
        if (stage === 4) {
          // any post-handshake byte from client → echo so we can prove the pipe is transparent
          sock.write(Buffer.concat([Buffer.from('ECHO:'), d]));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

function tick(ms = 40) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('runRfbBridge', () => {
  it('auths server-side type-2 and presents None + ServerInit to the client, then pipes transparently', async () => {
    const fake = await fakeServer();

    const toBridge = new PassThrough(); // client -> bridge
    const fromBridge = new PassThrough(); // bridge -> client
    const clientReads: Buffer[] = [];
    fromBridge.on('data', (d) => clientReads.push(d));

    const done = runRfbBridge({
      clientReadable: toBridge,
      clientWritable: fromBridge,
      vncHost: '127.0.0.1',
      vncPort: fake.port,
      password: PW,
    });

    await tick();
    // 1. bridge sent "RFB 003.008\n"
    expectEqual(Buffer.concat(clientReads).subarray(0, 12), Buffer.from('RFB 003.008\n', 'ascii'));
    clientReads.length = 0;
    toBridge.write(Buffer.from('RFB 003.008\n', 'ascii')); // client version
    await tick();
    // 2. bridge offers [count=1, type=1 None]
    expectEqual(Buffer.concat(clientReads).subarray(0, 2), Buffer.from([1, 1]));
    clientReads.length = 0;
    toBridge.write(Buffer.from([1])); // client chooses None
    await tick();
    // 3. bridge sends SecurityResult 0 (RFB 3.8: SecurityResult precedes ClientInit)
    expectEqual(Buffer.concat(clientReads).subarray(0, 4), Buffer.from([0, 0, 0, 0]));
    clientReads.length = 0;
    // 4. client sends ClientInit (shared flag); only THEN does the server send ServerInit
    toBridge.write(Buffer.from([1]));
    await tick();
    expectEqual(Buffer.concat(clientReads).subarray(0, SERVER_INIT.length), SERVER_INIT);
    clientReads.length = 0;

    await done; // handshake complete, pipe wired

    // 5. transparent pipe: a client byte after handshake reaches the server and the echo comes back
    toBridge.write(Buffer.from('PING'));
    await tick();
    const piped = Buffer.concat(clientReads).toString();
    expect(piped).toContain('ECHO:');
    expect(piped).toContain('PING');

    fake.close();
  });

  it('throws if the server does not offer type-2', async () => {
    // server offering only Apple types [30,33] → bridge must reject
    const srv = net.createServer((sock) => {
      let stage = 0;
      sock.write(Buffer.from('RFB 003.889\n', 'ascii'));
      sock.on('data', () => {
        if (stage === 0) {
          sock.write(Buffer.from([2, 30, 33]));
          stage = 1;
        }
      });
    });
    const port: number = await new Promise((resolve) =>
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)),
    );
    const toBridge = new PassThrough();
    const fromBridge = new PassThrough();
    fromBridge.resume();

    await expect(
      runRfbBridge({ clientReadable: toBridge, clientWritable: fromBridge, vncHost: '127.0.0.1', vncPort: port, password: PW }),
    ).rejects.toThrow(/type-2/);
    srv.close();
  });
});
