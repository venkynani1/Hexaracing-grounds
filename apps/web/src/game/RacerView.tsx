import { useEffect, useRef, useState } from 'react';
import {
  CAR_FLAG_BRAKING,
  CAR_FLAG_GHOST,
  Interpolator,
  PHASES,
  stageAt,
  Predictor,
  ProceduralBuildings,
  forwardSpeed,
  formatClock,
  generateBuildings,
  type WorldMap,
  type ClockState,
  type ClientMessage,
  type MapMessage,
  type Snapshot,
  type SquadView,
  type WorldState,
  stationExclusions,
} from '@redline/shared';
import { InputState } from './input';
import { api } from '../lib/api';
import { drawMap, type MapDot } from './minimap';
import { GameScene, type CameraMode, type Quality } from './scene';
import { autoQuality } from './render/autoQuality';
import { Announce, Arrow, MiniMap, Pedals, RaceClock, Speedo, Toast, Toasts } from './hud/Hud';
import './hud/hud.css';

export type WorldFeed = Snapshot | MapMessage;

export interface RacerViewProps {
  teamId: string;
  squadName: string;
  seed: string;
  clock: ClockState | null;
  offset: number;
  send: (m: ClientMessage) => void;
  subscribe: (fn: (m: WorldFeed) => void) => () => void;
  squad: SquadView | null;
  map: WorldMap;
  world: WorldState | null;
  token: string;
}

interface Hud {
  speed: number;
  fuel: number;
  health: number;
  tires: number;
  nitro: number;
  nitroOn: boolean;
  fps: number;
  scale: number;
  released: boolean;
  correction: number;
  traffic: number;
  others: number;
  ghost: boolean;
  canReset: boolean;
  /** waypoint arrow: angle relative to car heading (rad) and distance (m) */
  wpAngle: number | null;
  wpDist: number;
  /** next checkpoint guidance */
  cpIndex: number;
  cpTotal: number;
  cpAngle: number | null;
  cpDist: number;
  cells: number;
  bayDist: number;
  stName: string;
  stDist: number;
  stAngle: number;
  held: boolean;
}

const STEP_MS = 50;

export default function RacerView(props: RacerViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef(new InputState());
  const gameRef = useRef<GameScene | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [cam, setCam] = useState<CameraMode>('chase');
  const [quality, setQuality] = useState<Quality>(() => (localStorageGet('redline.quality') as Quality) || autoQuality());
  const [error, setError] = useState('');
  const mapRef = useRef<HTMLCanvasElement>(null);
  // Deceiver signal jam: server sends the remaining duration; scramble guidance locally until then
  const jamUntilRef = useRef(0);
  const jamMs = props.squad?.intel?.jammedForMs ?? 0;
  useEffect(() => {
    jamUntilRef.current = jamMs > 0 ? performance.now() + jamMs : 0;
  }, [jamMs, props.squad]);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const map = props.map;
    const net = map.net;
    let game: GameScene;
    try {
      game = new GameScene(canvas, map, props.seed, quality);
    } catch (e) {
      setError(`3D not available on this device: ${(e as Error).message}`);
      return;
    }
    gameRef.current = game;
    game.setMyCar(props.teamId);
    // Same static obstacles as the server so prediction matches (procedural cells on real maps).
    const ex = stationExclusions(map);
    const pb = map.id === 'test' ? null : new ProceduralBuildings(net, props.seed, ex);
    const fixed = map.id === 'test' ? generateBuildings(net, props.seed, ex) : [];
    // Closure barriers from the global world state are shared obstacles: predict them too.
    const barriers = () =>
      (propsRef.current.world?.closures ?? []).flatMap((c) => c.barriers.map((b) => ({ x: b.x, z: b.z, w: b.width, d: 1.2, h: 1.1, tone: 0, rot: b.heading })));
    const predictor = new Predictor(net, (x: number, z: number) => {
      const bs = barriers();
      const base = pb ? pb.near(x, z, 40) : fixed;
      return bs.length ? [...base, ...bs] : base;
    });
    const others = new Interpolator<{ id: number; x: number; z: number; heading: number; flags: number }>();
    // Global map channel (1 Hz): every squad, always — names + far positions.
    const roster = new Map<number, { teamId: string; name: string; x: number; z: number; heading: number }>();
    let myCid = 0;
    const traffic = new Interpolator<{ id: number; type: number; x: number; z: number; heading: number }>();
    const input = inputRef.current;
    input.attach();
    let lastSnap: { simMs: number; at: number; trafficN: number; othersN: number } = { simMs: 0, at: performance.now(), trafficN: 0, othersN: 0 };
    let live = false;
    let lastMe: Snapshot['me'] = null;
    let mapAt = 0;

    const unsub = props.subscribe((msg) => {
      if (msg.t === 'map') {
        for (const [cid, teamId, name, x, z, heading] of msg.cars) roster.set(cid, { teamId, name, x, z, heading });
        return;
      }
      const snap = msg;
      predictor.onSnapshot(snap);
      if (snap.me) myCid = snap.me.cid;
      lastMe = snap.me;
      others.push(snap.serverTime, snap.cars.map(([id, x, z, h, , flags]) => ({ id, x, z, heading: h, flags })));
      traffic.push(snap.serverTime, snap.traffic.map(([id, type, x, z, h]) => ({ id, type, x, z, heading: h })));
      lastSnap = { simMs: snap.simMs, at: performance.now(), trafficN: snap.traffic.length, othersN: snap.cars.length };
      game.setRain(snap.rain);
    });

    let acc = 0;
    let lastInput = input.sample(0);
    let last = performance.now();
    let hudAt = 0;
    let resAt = 0;
    game.engine.runRenderLoop(() => {
      const now = performance.now();
      const frameDt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const clock = propsRef.current.clock;
      live = clock?.status === 'LIVE';
      // Fixed 20 Hz input/prediction steps, mirroring the server tick.
      if (live) {
        acc += frameDt * 1000;
        if (acc > STEP_MS * 5) acc = STEP_MS * 5;
        while (acc >= STEP_MS) {
          acc -= STEP_MS;
          const inp = input.sample(STEP_MS / 1000);
          lastInput = inp;
          // Only send once we have authoritative state to predict from (exactly-once input application).
          if (predictor.state) propsRef.current.send(predictor.stepMessage(inp));
        }
      } else acc = 0;
      const pose = predictor.renderPose(acc / STEP_MS, frameDt);
      const serverNow = Date.now() + propsRef.current.offset;
      if (pose) {
        const st = pose.state;
        const fwd = forwardSpeed(st);
        const lat = st.vx * Math.cos(st.heading) - st.vz * Math.sin(st.heading);
        game.updateMe({
          x: pose.x,
          z: pose.z,
          heading: pose.heading,
          braking: predictor.braking,
          ghost: lastMe?.g,
          steer: lastInput.steer,
          speed: fwd,
          nitro: lastInput.nitro && st.nitro > 0,
          slip: Math.abs(lat) + (lastInput.handbrake && fwd > 5 ? 3 : 0),
        });
        game.updateCamera(pose, Math.abs(forwardSpeed(pose.state)), frameDt);
      }
      const near = others.sample(serverNow);
      game.updateOthers(
        near.map((c) => {
          const r = roster.get(c.id);
          return { ...c, braking: (c.flags & CAR_FLAG_BRAKING) !== 0, ghost: (c.flags & CAR_FLAG_GHOST) !== 0, label: r?.name, colorKey: r?.teamId ?? String(c.id) };
        }),
      );
      if (now - mapAt > 250 && mapRef.current) {
        mapAt = now;
        const nearIds = new Set(near.map((c) => c.id));
        const dots: MapDot[] = [];
        for (const [cid, r] of roster) if (cid !== myCid && !nearIds.has(cid)) dots.push({ id: cid, x: r.x, z: r.z, heading: r.heading, color: '#ff8a9a' });
        for (const c of near) dots.push({ id: c.id, x: c.x, z: c.z, heading: c.heading, ghost: (c.flags & CAR_FLAG_GHOST) !== 0 });
        const wpNode = waypointNode(map, propsRef.current.squad);
        for (const st of map.stations) dots.push({ id: st.id, x: st.x, z: st.z, heading: 0, color: '#2bd67b' });
        if (pose) dots.push({ id: 'me', x: pose.x, z: pose.z, heading: pose.heading, me: true });
        const course = lastMe?.cs ? map.courses[lastMe.cs] : undefined;
        const ctx = mapRef.current.getContext('2d');
        const jam = jamUntilRef.current > performance.now(); // Deceiver signal jam: navigation display scrambled
        if (ctx)
          drawMap(ctx, net, dots, {
            route: course && !jam ? courseRoute(map, course.des) : undefined,
            marks: jam ? undefined : course?.checkpoints.map((c, i) => ({ x: c.x, z: c.z, next: i === lastMe?.cp })),
            target: jam ? undefined : wpNode,
          });
      }
      game.updateTraffic(traffic.sample(serverNow));
      game.updateSignals(lastSnap.simMs + (live ? now - lastSnap.at : 0));
      game.setClosures(propsRef.current.world?.closures ?? []);
      game.scene.render();
      if (now - resAt > 500) {
        resAt = now;
        game.adaptResolution();
      }
      if (now - hudAt > 200 && pose) {
        hudAt = now;
        const s = pose.state;
        setHud({
          speed: Math.abs(forwardSpeed(s)) * 3.6,
          fuel: s.fuel,
          health: s.health,
          tires: s.tires,
          nitro: s.nitro,
          nitroOn: lastInput.nitro,
          fps: Math.round(game.engine.getFps()),
          scale: game.renderScale,
          released: predictor.released,
          correction: predictor.lastCorrection,
          traffic: lastSnap.trafficN,
          others: lastSnap.othersN,
          ghost: !!lastMe?.g,
          canReset: !!lastMe?.rs,
          ...(() => {
            const wp = waypointNode(map, propsRef.current.squad);
            if (!wp) return { wpAngle: null, wpDist: 0 };
            const bearing = Math.atan2(wp.x - pose.x, wp.z - pose.z);
            return { wpAngle: bearing - pose.heading, wpDist: Math.hypot(wp.x - pose.x, wp.z - pose.z) };
          })(),
          ...(() => {
            const course = lastMe?.cs ? map.courses[lastMe.cs] : undefined;
            const cp = course?.checkpoints[lastMe?.cp ?? 0];
            if (!course || !cp) return { cpIndex: lastMe?.cp ?? 0, cpTotal: course?.checkpoints.length ?? 0, cpAngle: null, cpDist: 0 };
            return {
              cpIndex: lastMe!.cp,
              cpTotal: course.checkpoints.length,
              cpAngle: Math.atan2(cp.x - pose.x, cp.z - pose.z) - pose.heading,
              cpDist: Math.hypot(cp.x - pose.x, cp.z - pose.z),
            };
          })(),
          cells: game.loadedCells,
          ...(() => {
            let best: { name: string; d: number; a: number } | null = null;
            for (const st of map.stations) {
              const d = Math.hypot(st.x - pose.x, st.z - pose.z);
              if (!best || d < best.d) best = { name: st.name, d, a: Math.atan2(st.x - pose.x, st.z - pose.z) - pose.heading };
            }
            const g = propsRef.current.squad?.gate;
            return { stName: best?.name ?? '', stDist: best?.d ?? 0, stAngle: best?.a ?? 0, held: !!lastMe?.hd, bayDist: g ? Math.hypot(g.parking.x - pose.x, g.parking.z - pose.z) : 0 };
          })(),
        });
      }
    });
    const onResize = () => game.engine.resize();
    window.addEventListener('resize', onResize);
    return () => {
      unsub();
      input.detach();
      window.removeEventListener('resize', onResize);
      game.dispose();
      gameRef.current = null;
    };
    // The scene is built once per mount; quality changes are applied below without rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.teamId, props.seed, props.map]);

  useEffect(() => gameRef.current?.setCameraMode(cam), [cam]);
  useEffect(() => {
    gameRef.current?.setQuality(quality);
    try {
      localStorage.setItem('redline.quality', quality);
    } catch {
      /* ignore */
    }
  }, [quality]);

  const clock = props.clock;
  const phase = PHASES.find((p) => p.id === clock?.phase);
  const jammed = jamUntilRef.current > performance.now();
  const safe = props.squad?.safeHold;
  const cams: CameraMode[] = ['chase', 'hood', 'top'];
  const qualities: Quality[] = ['low', 'medium', 'high', 'ultra'];
  const debug = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
  const ann = props.world?.announcement;
  const elapsed = clock?.elapsedMs ?? 0;
  const pitActive = !!props.squad?.pit?.stage?.match(/queued|in_bay|servicing/);

  return (
    <div className="rh racer">
      <canvas ref={canvasRef} className="game-canvas" data-testid="game-canvas" touch-action="none" />
      {error && <div className="racer-error">{error}</div>}
      <RaceClock
        phase={clock?.status === 'LIVE' ? stageAt(clock.elapsedMs).label || phase?.label || '' : clock?.status === 'COUNTDOWN' ? 'Ignition' : clock?.status ?? ''}
        time={clock?.status === 'COUNTDOWN' ? String(Math.ceil(clock.countdownRemainingMs / 1000)) : formatClock(elapsed)}
      />
      <div className="rh-tools">
        <button className="rh-chip" onClick={() => setCam(cams[(cams.indexOf(cam) + 1) % cams.length]!)} data-testid="btn-camera">
          {cam}
        </button>
        <button className="rh-chip" onClick={() => setQuality(qualities[(qualities.indexOf(quality) + 1) % qualities.length]!)}>
          {quality}
        </button>
        <span className="rh-chip mono" data-testid="fps" data-fps={hud?.fps ?? 0}>
          {hud?.fps ?? 0} fps
        </span>
      </div>
      <MiniMap canvasRef={mapRef} />
      {ann && <Announce id={`${ann.atMs}`} text={ann.text} expired={elapsed - ann.atMs > 12_000 || elapsed < ann.atMs - 1000} />}
      <Toasts>
        {jammed && (
          <Toast tone="warn" testid="nav-jammed">
            NAVIGATION JAMMED by a rival Deceiver — guidance returns in {Math.ceil((jamUntilRef.current - performance.now()) / 1000)} s
          </Toast>
        )}
        {safe?.available && (
          <Toast tone="info" testid="safe-hold-offer">
            Major puzzle open —{' '}
            <button className="btn" onClick={() => props.token && void api.squad.safeHold(props.token, true).catch(() => undefined)} data-testid="safe-hold-on">
              Safe-hold the car (≤ 90 s)
            </button>
          </Toast>
        )}
        {hud && hud.cpTotal > 0 && !jammed && (
          <Toast tone="warn" testid="checkpoint-guide">
            {hud.cpIndex < hud.cpTotal ? (
              <>
                <Arrow angle={hud.cpAngle ?? 0} />
                {hud.cpIndex === hud.cpTotal - 1 ? 'Hexaware Gate' : `Checkpoint ${hud.cpIndex + 1}/${hud.cpTotal}`} · {Math.round(hud.cpDist)} m
              </>
            ) : (
              <>All checkpoints cleared ✓</>
            )}
          </Toast>
        )}
        {props.squad && <RacerSquadHud squad={props.squad} hud={hud} map={props.map} />}
        {hud && !pitActive && hud.fuel < 35 && hud.stName && (
          <Toast tone="good" testid="fuel-hint">
            <Arrow angle={hud.stAngle} />
            Low fuel — {hud.stName} · {Math.round(hud.stDist)} m · stop on the forecourt
          </Toast>
        )}
        {props.squad?.pit && props.squad.pit.stage !== 'done' && <PitHud pit={props.squad.pit} />}
        {props.squad?.gate && props.squad.gate.status === 'open' && <GateHud gate={props.squad.gate} send={props.send} token={props.token} hud={hud} />}
      </Toasts>
      {hud && !hud.released && clock?.status === 'LIVE' && <div className="rh-center-banner">Cars release at 03:00 — City Sprint. Engines warm.</div>}
      {clock?.status === 'PAUSED' && <div className="rh-center-banner">Paused by host</div>}
      {safe?.active && (
        <div className="rh-center-banner" data-testid="safe-hold-banner">
          Safe-hold — car parked while your squad solves the puzzle ({Math.ceil(safe.remainingMs / 1000)} s max){' '}
          <button className="btn" onClick={() => props.token && void api.squad.safeHold(props.token, false).catch(() => undefined)} data-testid="safe-hold-off">
            Release
          </button>
        </div>
      )}
      {hud?.held && !props.squad?.pit && !safe?.active && <div className="rh-center-banner">Roadside recovery — tank empty. +15% fuel in a few seconds (50 credits).</div>}
      {hud?.ghost && <div className="rh-center-banner">Ghosted for repeated ramming — non-collidable for 5 s, clean-driving penalty logged</div>}
      {hud?.canReset && (
        <button className="btn primary rh-reset" onClick={() => props.send({ t: 'reset' })} data-testid="btn-reset">
          Safe reset to lane
        </button>
      )}
      <Speedo speed={hud?.speed ?? 0} nitro={hud?.nitro ?? 0} fuel={hud?.fuel ?? 0} health={hud?.health ?? 0} tires={hud?.tires ?? 0} nitroOn={hud?.nitroOn} />
      <Pedals input={inputRef.current} />
      {debug && (
        <div className="rh-debug mono">
          {props.squadName} · traffic {hud?.traffic ?? 0} · squads near {hud?.others ?? 0} · cells {hud?.cells ?? 0} · res ×{(1 / (hud?.scale ?? 1)).toFixed(2)} · corr {(hud?.correction ?? 0).toFixed(2)} m
        </div>
      )}
      <a className="rh-attrib" href="/credits" target="_blank" rel="noreferrer" data-testid="osm-attribution">
        {props.map.id === 'chennai' ? `Map data ${props.map.attribution} · Chennai at ${Math.round(props.map.scale * 100)}% scale · credits` : 'Synthetic test map'}
      </a>
    </div>
  );
}

function waypointNode(map: WorldMap, squad: SquadView | null) {
  const wp = squad?.waypoint ? map.waypoints.find((w) => w.id === squad.waypoint) : null;
  return wp ? map.net.nodes[wp.node]! : null;
}

const routeCache = new WeakMap<number[], { x: number; z: number }[]>();
function courseRoute(map: WorldMap, des: number[]) {
  let r = routeCache.get(des);
  if (!r) {
    r = des.map((de) => {
      const e = map.net.edges[de >> 1]!;
      return map.net.nodes[de & 1 ? e.a : e.b]!;
    });
    routeCache.set(des, r);
  }
  return r;
}

/** Racer's slice of squad play: own private clue, Captain's waypoint arrow, buffs. */
function RacerSquadHud({ squad, hud, map }: { squad: SquadView; hud: Hud | null; map: WorldMap }) {
  const clue = squad.challenges.find((c) => c.status === 'open' && c.clue);
  const wp = squad.waypoint ? map.waypoints.find((w) => w.id === squad.waypoint) : null;
  return (
    <>
      {wp && hud?.wpAngle != null && (
        <Toast tone="info" testid="racer-waypoint">
          <Arrow angle={hud.wpAngle} />
          {wp.label} · {Math.round(hud.wpDist)} m
        </Toast>
      )}
      {clue && (
        <Toast tone="info" testid="racer-clue">
          <span>
            <span className="eyebrow">{clue.title} — your clue</span>
            <div>{clue.clue}</div>
          </span>
        </Toast>
      )}
      {squad.buffs.map((b) => (
        <Toast key={b.kind} tone="good">⚡ {b.kind.replace('_', ' ')}</Toast>
      ))}
    </>
  );
}

/** Racer's slice of the gate: escort request, disclosed escort banner, parking-bay guidance. */
function GateHud({ gate, token, hud }: { gate: import('@redline/shared').GateView; send: RacerViewProps['send']; token: string; hud: Hud | null }) {
  const [msg, setMsg] = useState('');
  if (gate.escorting)
    return (
      <Toast tone="info" testid="escort-banner">
        ESCORT — disclosed, time-compressed transfer along your course roads. Skipped checkpoints score 0.
      </Toast>
    );
  return (
    <Toast tone="gold" testid="gate-hud">
      {gate.arrival ? (
        <span>
          Park in bay {gate.parking.spot} {gate.parking.points !== null ? `✓ +${gate.parking.points}` : hud ? `· ${Math.round(hud.bayDist)} m` : ''}
        </span>
      ) : (
        <button className="btn primary" onClick={() => api.squad.gateEscort(token).then(() => setMsg('Escort requested'), (e) => setMsg(e.message))} data-testid="racer-escort">
          Request escort to the gate
        </button>
      )}
      {gate.myDigit.digit !== null && <span> · Access digit #1: <b>{gate.myDigit.digit}</b></span>}
      {msg && <span className="hint"> {msg}</span>}
    </Toast>
  );
}

const STEP_LABEL: [keyof import('@redline/shared').PitView['steps'], string][] = [
  ['enter', 'Enter'],
  ['select', 'Captain'],
  ['diagnose', 'Engineer'],
  ['verify', 'Deceiver'],
  ['confirm', 'Confirm'],
  ['release', 'Release'],
];

function PitHud({ pit }: { pit: import('@redline/shared').PitView }) {
  return (
    <Toast tone="good" testid="pit-hud">
      <span>
        <span className="eyebrow">{pit.stationName}</span>
        {pit.stage === 'queued' ? `Queued — position ${pit.queuePosition}` : pit.stage === 'in_bay' ? `Bay ${pit.bay! + 1} — crew rolled you in` : 'Servicing…'}
        {pit.dwellLeftMs != null && ` · ${Math.ceil(pit.dwellLeftMs / 1000)} s max`}
        {pit.serviceLeftMs != null && ` · ${Math.ceil(pit.serviceLeftMs / 1000)} s`}
        <span className="pit-steps">
          {STEP_LABEL.map(([k, l]) => (
            <span key={k} className={pit.steps[k] ? 'done' : ''}>
              {pit.steps[k] ? '✓' : '·'} {l}{' '}
            </span>
          ))}
        </span>
      </span>
    </Toast>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
