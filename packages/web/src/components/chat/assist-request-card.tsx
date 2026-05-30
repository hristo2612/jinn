import { useContext, useEffect, useState } from 'react';
import { GatewayContext } from '@/hooks/use-gateway';
import { TakeoverModal } from './takeover-modal';

type Status = 'pending' | 'resolved' | 'timed_out';

export function AssistRequestCard(props: {
  reqId: string; reason: string; url?: string; status?: Status;
}) {
  const [status, setStatus] = useState<Status>(props.status ?? 'pending');
  const [open, setOpen] = useState(false);
  // Read the gateway context directly (not useGateway) so the card renders fine
  // in isolation (e.g. unit tests) where no GatewayProvider is mounted.
  const gateway = useContext(GatewayContext);

  // Reconcile live status on mount (persisted card may be stale after reload).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/assist/${props.reqId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.status) setStatus(d.status); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [props.reqId]);

  // Live flip: react to assist resolve/timeout events for THIS reqId without reload.
  useEffect(() => {
    if (!gateway) return;
    return gateway.subscribe((event, payload) => {
      const p = payload as { reqId?: string; status?: Status } | undefined;
      if (p?.reqId !== props.reqId) return;
      if (event === 'session:assist-resolved') {
        setStatus(p.status === 'timed_out' ? 'timed_out' : 'resolved');
        setOpen(false);
      }
    });
  }, [gateway, props.reqId]);

  async function resume() {
    await fetch(`/api/assist/${props.reqId}/resolve`, { method: 'POST' });
    setStatus('resolved');
    setOpen(false);
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="font-medium">🙋 Help needed</div>
      <div className="mt-1 opacity-80">{props.reason}</div>
      {props.url && <a className="mt-1 block truncate text-xs underline opacity-70" href={props.url} target="_blank" rel="noreferrer">{props.url}</a>}
      {status === 'pending' && (
        <div className="mt-2 flex gap-2">
          <button className="rounded bg-amber-600 px-3 py-1 text-white" onClick={() => setOpen(true)}>Take control</button>
          <button className="rounded border px-3 py-1" onClick={resume}>Resume agent</button>
        </div>
      )}
      {status === 'resolved' && <div className="mt-2 text-xs opacity-60">✅ Resolved</div>}
      {status === 'timed_out' && <div className="mt-2 text-xs opacity-60">⏱️ Timed out — agent will re-request if needed</div>}
      {open && <TakeoverModal reqId={props.reqId} onResume={resume} onClose={() => setOpen(false)} />}
    </div>
  );
}
