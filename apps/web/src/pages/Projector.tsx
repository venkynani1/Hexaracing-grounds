import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LEVELS, formatClock, stageAt, type ConvoyTimeline, type MapMessage, type ServerMessage, type Standing, type WorldState, type ClockState } from '@redline/shared';
import { api } from '../lib/api';
import { useWorldSocket } from '../lib/socket';
import { useWorldMap } from '../game/useWorldMap';
import { drawMap } from '../game/minimap';
import { Brand, useLiveClock } from '../components';
import type { WorldFeed } from '../game/RacerView';

const Finale = lazy(() => import('../game/Finale'));
const KEY = 'redline.hostkey';

/** Projector (SPEC Part 17): the SAME world — real positions of all squads, live standings, then the finale. */
export function Projector() {
  const [hostKey, setHostKey] = useState(() => sessionStorage.getItem(KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [map, setMap] = useState<MapMessage | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [timeline, setTimeline] = useState<ConvoyTimeline | null>(null);
  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [mapId, setMapId] = useState<'test' | 'chennai' | undefined>();
  const [seed, setSeed] = useState('');
  const listeners = useRef(new Set<(m: WorldFeed) => void>());
  const subscribe = useCallback((fn: (m: WorldFeed) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  useEffect(
    () =>
      void api.event().then(
        (e) => (setMapId(e.map), setSeed(e.worldSeed)),
        () => {},
      ),
    [],
  );
  const worldMap = useWorldMap(mapId);
  const onMessage = useCallback((m: ServerMessage) => {
    if (m.t === 'map') {
      setMap(m);
      for (const fn of listeners.current) fn(m);
    } else if (m.t === 'welcome' && m.kind === 'host') setClock(m.overview.clock);
    else if (m.t === 'overview') setClock(m.overview.clock);
    else if (m.t === 'clock') setClock(m.clock);
    else if (m.t === 'world') setWorld(m.state);
    else if (m.t === 'convoy') setTimeline(m.timeline);
    else if (m.t === 'championship') setStandings(m.standings);
  }, []);
  const { offset } = useWorldSocket(hostKey ? { t: 'host_hello', hostKey } : null, onMessage);
  const live = useLiveClock(clock, offset);
  // Live leaderboard (derived from scoring_events on the server).
  const [live10, setLive10] = useState<Standing[]>([]);
  useEffect(() => {
    if (!hostKey) return;
    const tick = () => api.standings().then((r) => setLive10(r.standings.slice(0, 10)), () => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [hostKey]);

  if (!hostKey) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      sessionStorage.setItem(KEY, draft);
      setHostKey(draft);
    };
    return (
      <main className="page narrow">
        <Brand />
        <form className="card" onSubmit={submit}>
          <label>
            Host key
            <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <button className="btn primary wide">Open projector</button>
        </form>
      </main>
    );
  }
  if (timeline && worldMap) {
    return (
      <Suspense fallback={null}>
        <Finale map={worldMap} seed={seed} clock={live} offset={offset} subscribe={subscribe} timeline={timeline} standings={standings} />
      </Suspense>
    );
  }
  return (
    <main className="projector" data-testid="projector">
      <header className="topbar">
        <Brand small />
        <div className="proj-clock">{live ? formatClock(live.elapsedMs) : '--:--'}</div>
        <div className="proj-stage" data-testid="projector-stage">
          {live?.status === 'LIVE' ? stageAt(live.elapsedMs).label : live?.status === 'COUNTDOWN' ? 'Countdown' : live?.status === 'PAUSED' ? 'Paused' : 'Event lobby'}
          {live?.status === 'LIVE' && stageAt(live.elapsedMs).level && (
            <span className="hint"> · {stageAt(live.elapsedMs).level!.purpose} · {LEVELS.map((l) => (l.n <= stageAt(live.elapsedMs).level!.n ? '●' : '○')).join('')}</span>
          )}
        </div>
        <div className="hint">{world?.rain ? 'Rain' : 'Dry'} {world?.closures.length ? `· Closed: ${world.closures.map((c) => c.label).join(', ')}` : ''}</div>
      </header>
      <div className="proj-grid">
        {map && worldMap && <ProjectorMap map={map} world={worldMap} />}
        <ol className="proj-board" data-testid="projector-standings">
          {live10.map((s) => (
            <li key={s.teamId}>
              <span className="rank">{s.rank}</span> {s.name} <b>{s.total}</b>
            </li>
          ))}
        </ol>
      </div>
      {world?.announcement && <div className="proj-announce">{world.announcement.text}</div>}
    </main>
  );
}

function ProjectorMap({ map, world }: { map: MapMessage; world: NonNullable<ReturnType<typeof useWorldMap>> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const net = useMemo(() => world.net, [world]);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const gate = world.net.nodes[world.destination.node]!;
    drawMap(ctx, net, map.cars.map(([cid, , name, x, z, heading]) => ({ id: cid, x, z, heading, label: name })), { labels: true, dpr: 2, target: { x: gate.x, z: gate.z } });
  }, [map, net, world]);
  return (
    <div className="proj-map">
      <canvas ref={ref} width={1400} height={1400} data-testid="projector-map" />
      <div className="hint">Map data {world.attribution} · real server positions only</div>
    </div>
  );
}
