import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ROLE_LABEL, formatClock, type HostOverview, type MapMessage, type ServerMessage, type WorldMap, type WorldState } from '@redline/shared';
import { drawMap } from '../game/minimap';
import { useWorldMap } from '../game/useWorldMap';
import { api, HttpError } from '../lib/api';
import { useWorldSocket } from '../lib/socket';
import { Brand, ClockPanel, Qr, useLiveClock } from '../components';

const KEY = 'redline.hostkey';

export function Host() {
  const [hostKey, setHostKey] = useState<string>(() => sessionStorage.getItem(KEY) ?? '');
  const [draftKey, setDraftKey] = useState('');
  const [ov, setOv] = useState<HostOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [map, setMap] = useState<MapMessage | null>(null);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [mapId, setMapId] = useState<'test' | 'chennai' | undefined>();
  useEffect(() => void api.event().then((e) => setMapId(e.map), () => {}), []);
  const worldMap = useWorldMap(mapId);

  const onMessage = useCallback((m: ServerMessage) => {
    if (m.t === 'welcome' && m.kind === 'host') setOv(m.overview);
    else if (m.t === 'overview') setOv(m.overview);
    else if (m.t === 'clock') setOv((o) => (o ? { ...o, clock: m.clock } : o));
    else if (m.t === 'map') setMap(m);
    else if (m.t === 'world') setWorld(m.state);
    else if (m.t === 'error' && m.error === 'UNAUTHORIZED') {
      sessionStorage.removeItem(KEY);
      setHostKey('');
      setError('Invalid host key');
    }
  }, []);
  const { status, offset } = useWorldSocket(hostKey ? { t: 'host_hello', hostKey } : null, onMessage);
  const live = useLiveClock(ov?.clock ?? null, offset);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setOv(await api.host.overview(hostKey));
    } catch (e) {
      setError(e instanceof HttpError ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  if (!hostKey) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      sessionStorage.setItem(KEY, draftKey);
      setHostKey(draftKey);
    };
    return (
      <main className="page narrow">
        <Brand />
        <form className="card" onSubmit={submit}>
          <label>
            Host key
            <input type="password" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} required data-testid="host-key" />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary wide" data-testid="host-login">Open control center</button>
        </form>
      </main>
    );
  }

  const st = ov?.clock.status;
  const registrationUrl = `${location.origin}/`;
  return (
    <main className="page wide">
      <header className="topbar">
        <Brand small />
        <span className="eyebrow">Host control center</span>
        <span className={`conn conn-${status}`}>{status === 'open' ? 'Live link' : 'Reconnecting…'}</span>
      </header>
      {!ov ? (
        <p className="muted">Connecting to the world server…</p>
      ) : (
        <section className="host-grid">
          <div className="card center">
            <ClockPanel clock={live} />
            <div className="controls">
              {st === 'REGISTRATION_OPEN' && (
                <>
                  <button className="btn primary start" disabled={busy || !ov.canStart} onClick={() => act(() => api.host.start(hostKey))} data-testid="start">
                    START
                  </button>
                  {!ov.canStart && ov.squadCount > 0 && (
                    <button
                      className="btn ghost"
                      disabled={busy}
                      onClick={() => confirm('Start with incomplete squads? This is audit-logged.') && act(() => api.host.start(hostKey, true))}
                    >
                      Force start
                    </button>
                  )}
                </>
              )}
              {(st === 'LIVE' || st === 'COUNTDOWN') && (
                <button className="btn" disabled={busy} onClick={() => act(() => api.host.pause(hostKey))} data-testid="pause">
                  Emergency pause
                </button>
              )}
              {st === 'PAUSED' && (
                <button className="btn primary" disabled={busy} onClick={() => act(() => api.host.resume(hostKey))} data-testid="resume">
                  Resume
                </button>
              )}
            </div>
            {ov.startBlockers.length > 0 && st === 'REGISTRATION_OPEN' && (
              <ul className="blockers" data-testid="blockers">
                {ov.startBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {error && <div className="error">{error}</div>}
          </div>
          <div className="card stats">
            <Stat label="Squads" value={`${ov.squadCount}/${ov.maxSquads}`} testid="stat-squads" />
            <Stat label="Players" value={`${ov.playerCount}/${ov.maxSquads * 4}`} testid="stat-players" />
            <Stat label="Connected" value={String(ov.connectedCount)} />
            <Stat label="Database" value={ov.health.db ? 'OK' : 'DOWN'} />
            <Stat label="Uptime" value={`${Math.floor(ov.health.uptimeS / 60)}m`} />
            <Stat label="World" value="1 room" />
          </div>
          <div className="card center">
            <Qr value={registrationUrl} size={200} label="Scan to register" />
            <p className="hint">{registrationUrl}</p>
          </div>
          {world && (
            <div className="card" data-testid="host-world">
              <h2>Director & world</h2>
              <p>
                Weather: <b data-testid="host-weather">{world.rain ? 'Rain (grip −20%)' : 'Dry'}</b> · Fuel price ×{world.fuelPriceMul} · Closures:{' '}
                {world.closures.length ? world.closures.map((c) => c.label).join(', ') : 'none'}
              </p>
              <ul className="beats">
                {world.beats.map((b) => (
                  <li key={b.beat}>
                    <span className="mono">{formatClock(b.atMs)}</span> {b.beat} — {b.decision}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {map && worldMap && <LiveMap map={map} world={worldMap} />}
          <div className="card squads">
            <h2>Squads</h2>
            {ov.squads.length === 0 && <p className="muted">No squads yet.</p>}
            <table data-testid="squad-table">
              <thead>
                <tr>
                  <th>Squad</th>
                  <th>Code</th>
                  <th>Start</th>
                  <th>Roster</th>
                  <th>Ready</th>
                </tr>
              </thead>
              <tbody>
                {ov.squads.map((s) => (
                  <tr key={s.teamId} data-testid="squad-row">
                    <td>{s.name}</td>
                    <td className="mono">{s.joinCode}</td>
                    <td>{s.startLocation ?? '— (auto)'}</td>
                    <td>
                      {s.players.map((p) => (
                        <span key={p.playerId} className="mini-player" title={ROLE_LABEL[p.role]}>
                          <span className={`dot ${p.connected ? 'on' : ''}`} />
                          {p.displayName} <small>{ROLE_LABEL[p.role].slice(0, 2)}</small>
                        </span>
                      ))}
                    </td>
                    <td>{s.ready ? '✓' : `${s.players.length}/4`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

/** Live map of the ONE world: actual server positions of every squad car (no fabricated positions). */
function LiveMap({ map, world }: { map: MapMessage; world: WorldMap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const net = useMemo(() => world.net, [world]);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    drawMap(
      ctx,
      net,
      map.cars.map(([cid, , name, x, z, heading]) => ({ id: cid, x, z, heading, label: name })),
      { labels: true, dpr: 2, target: { x: world.net.nodes[world.destination.node]!.x, z: world.net.nodes[world.destination.node]!.z } },
    );
  }, [map, net, world]);
  return (
    <div className="card center map-card">
      <div className="eyebrow">Live world · {map.cars.length} squad cars · tick {map.tick}</div>
      <canvas ref={ref} className="host-map" width={1200} height={1200} data-testid="host-map" />
      <div className="hint" data-testid="host-map-attribution">
        {world.id === 'chennai' ? `Map data ${world.attribution} · Chennai at ${Math.round(world.scale * 100)}% scale · ◯ Hexaware Gate` : 'Synthetic test map'}
      </div>
    </div>
  );
}

function Stat({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="stat">
      <div className="stat-v" data-testid={testid}>{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}
