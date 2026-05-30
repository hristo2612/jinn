import { useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Lazy noVNC: a *dynamic* import() keeps the heavy RFB client out of the main/page
// bundle — Rollup splits it into its own chunk and it is fetched on demand, not as
// part of the app shell. It is loaded here (rather than via a static top-level
// `import RFB from ...`) precisely so noVNC stays in a lazy chunk; the promise is
// memoized so repeated mounts reuse the same in-flight load.
const rfbModule = import('@novnc/novnc');

function vncUrl(reqId: string): string {
  const gw = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (gw) return `${gw.replace(/^http/, 'ws')}/api/assist/${reqId}/vnc`;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/assist/${reqId}/vnc`;
  }
  return `ws://127.0.0.1:7777/api/assist/${reqId}/vnc`;
}

export function TakeoverModal(props: { reqId: string; onResume: () => void; onClose: () => void }) {
  const rfbRef = useRef<any>(null);
  const { reqId } = props;

  // Callback ref: the screen container only exists once Radix mounts the portal,
  // so attach noVNC the moment the element is available — a parent useEffect runs
  // while the portal child ref is still null. RFB is constructed lazily on mount.
  const attachScreen = useCallback((el: HTMLDivElement | null) => {
    if (!el || rfbRef.current) return;
    rfbModule.then(({ default: RFB }) => {
      if (rfbRef.current) return;
      // Server-side auth presents security-type None → no credentials in the browser.
      const rfb = new RFB(el, vncUrl(reqId));
      rfb.scaleViewport = true;
      rfb.clipViewport = false;
      rfb.focusOnClick = true;
      rfbRef.current = rfb;
    });
  }, [reqId]);

  function resume() {
    try { rfbRef.current?.disconnect(); } catch { /* best-effort */ }
    props.onResume();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent className="max-w-[90vw]">
        <DialogHeader><DialogTitle>Screen takeover — Mac mini</DialogTitle></DialogHeader>
        <div ref={attachScreen} className="h-[70vh] w-full overflow-hidden rounded bg-black" />
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded bg-green-600 px-4 py-1.5 text-white" onClick={resume}>Resume agent</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
