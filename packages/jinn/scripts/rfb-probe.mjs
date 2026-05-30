// Probe the RFB security types offered by screensharingd on 127.0.0.1:5900.
// Prints the list and whether legacy VNC auth (type 2) is present.
import net from 'net';
const s = net.connect(5900, '127.0.0.1');
let stage = 0;
const to = setTimeout(() => { console.log('probe timeout (is Screen Sharing on?)'); process.exit(1); }, 4000);
s.on('data', (buf) => {
  if (stage === 0) {
    console.log('server version:', JSON.stringify(buf.toString('ascii').trim()));
    s.write('RFB 003.008\n');
    stage = 1;
    return;
  }
  const count = buf[0];
  const types = Array.from(buf.subarray(1, 1 + count));
  console.log('security types:', types);
  console.log(types.includes(2) ? 'TYPE 2 PRESENT ✅ (legacy VNC auth — bridge will work)'
                                 : 'TYPE 2 ABSENT ❌ (run enable-vnc-legacy.sh, or fall back to Option-A)');
  clearTimeout(to);
  s.destroy();
  process.exit(types.includes(2) ? 0 : 2);
});
s.on('error', (e) => { console.log('probe error:', e.message); process.exit(1); });
