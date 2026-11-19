import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@redline/shared';
import { wsUrl } from './api';

export type SocketStatus = 'connecting' | 'open' | 'closed';

/**
 * Auto-reconnecting WebSocket to the single world. `hello` is re-sent on every (re)connect,
 * so the server re-binds the same slot. Server time offset is estimated from ping/pong.
 */
export function useWorldSocket(hello: ClientMessage | null, onMessage: (m: ServerMessage) => void) {
  const [status, setStatus] = useState<SocketStatus>('connecting');
  const [offset, setOffset] = useState(0);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const helloKey = hello ? JSON.stringify(hello) : null;

  useEffect(() => {
    if (!helloKey) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      setStatus('connecting');
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        retry = 0;
        setStatus('open');
        ws!.send(helloKey);
        const ping = () => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'ping', clientTime: Date.now() }));
        ping();
        pingTimer = setInterval(ping, 10_000);
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as ServerMessage;
        if (m.t === 'pong') {
          const rtt = Date.now() - m.clientTime;
          setOffset(m.serverTime + rtt / 2 - Date.now());
          return;
        }
        handler.current(m);
      };
      ws.onclose = (ev) => {
        clearInterval(pingTimer);
        setStatus('closed');
        if (closed || ev.code === 4001 || ev.code === 4003) return;
        retryTimer = setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
      };
    };
    open();
    return () => {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [helloKey]);

  return { status, offset };
}
