import { useEffect, useRef, useState } from 'react';
import {
  CAR_FLAG_BRAKING,
  CAR_FLAG_GHOST,
  Interpolator,
  PHASES,
  Predictor,
  createTestNetwork,
  forwardSpeed,
  formatClock,
  generateBuildings,
  type ClockState,
  type ClientMessage,
  type MapMessage,
  type Snapshot,
  type SquadView,
  WAYPOINTS,
} from '@redline/shared';
import { InputState, type Control } from './input';
import { drawMap, type MapDot } from './minimap';
import { GameScene, type CameraMode, type Quality } from './scene';

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
}

interface Hud {
  speed: number;
  fuel: number;
  health: number;
  tires: number;
  nitro: number;
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
}

const STEP_MS = 50;

export default function RacerView(props: RacerViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef(new InputState());
  const gameRef = useRef<GameScene | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [cam, setCam] = useState<CameraMode>('chase');
  const [quality, setQuality] = useState<Quality>(() => (localStorageGet('redline.quality') as Quality) || 'medium');
  const [error, setError] = useState('');
  const mapRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const net = createTestNetwork();
    const buildings = generateBuildings(net, props.seed);
    let game: GameScene;
    try {
      game = new GameScene(canvas, net, buildings, props.seed, quality);
    } catch (e) {
      setError(`3D not available on this device: ${(e as Error).message}`);
      return;
    }
    gameRef.current = game;
    game.setMyCar(props.teamId);
    const predictor = new Predictor(net, buildings);
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
          // Only send once we have authoritative state to predict from (exactly-once input application).
          if (predictor.state) propsRef.current.send(predictor.stepMessage(inp));
        }
      } else acc = 0;
      const pose = predictor.renderPose(acc / STEP_MS, frameDt);
      const serverNow = Date.now() + propsRef.current.offset;
      if (pose) {
        game.updateMe({ x: pose.x, z: pose.z, heading: pose.heading, braking: predictor.braking, ghost: lastMe?.g });
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
        const wpNode = waypointNode(propsRef.current.squad);
        if (wpNode) dots.push({ id: 'wp', x: wpNode.x, z: wpNode.z, heading: 0, color: '#38c8ff' });
        if (pose) dots.push({ id: 'me', x: pose.x, z: pose.z, heading: pose.heading, me: true });
        const ctx = mapRef.current.getContext('2d');
        if (ctx) drawMap(ctx, net, dots);
      }
      game.updateTraffic(traffic.sample(serverNow));
      game.updateSignals(lastSnap.simMs + (live ? now - lastSnap.at : 0));
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
          fps: Math.round(game.engine.getFps()),
          scale: game.renderScale,
          released: predictor.released,
          correction: predictor.lastCorrection,
          traffic: lastSnap.trafficN,
          others: lastSnap.othersN,
          ghost: !!lastMe?.g,
          canReset: !!lastMe?.rs,
          ...(() => {
            const wp = waypointNode(propsRef.current.squad);
            if (!wp) return { wpAngle: null, wpDist: 0 };
            const bearing = Math.atan2(wp.x - pose.x, wp.z - pose.z);
            return { wpAngle: bearing - pose.heading, wpDist: Math.hypot(wp.x - pose.x, wp.z - pose.z) };
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
  }, [props.teamId, props.seed]);

  useEffect(() => gameRef.current?.setCameraMode(cam), [cam]);
  useEffect(() => {
    gameRef.current?.setQuality(quality);
    try {
      localStorage.setItem('redline.quality', quality);
    } catch {
      /* ignore */
    }
  }, [quality]);

  const hold = (c: Control) => ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      inputRef.current.set(c, true);
    },
    onPointerUp: () => inputRef.current.set(c, false),
    onPointerCancel: () => inputRef.current.set(c, false),
    onPointerLeave: () => inputRef.current.set(c, false),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  const clock = props.clock;
  const phase = PHASES.find((p) => p.id === clock?.phase);
  const cams: CameraMode[] = ['chase', 'hood', 'top'];
  const qualities: Quality[] = ['low', 'medium', 'high', 'ultra'];

  return (
    <div className="racer">
      <canvas ref={canvasRef} className="game-canvas" data-testid="game-canvas" touch-action="none" />
      {error && <div className="racer-error">{error}</div>}
      <div className="hud-top">
        <div className="hud-clock">
          <div className="hud-phase">{clock?.status === 'LIVE' ? phase?.label : clock?.status === 'COUNTDOWN' ? 'Ignition' : clock?.status}</div>
          <div className="hud-time">
            {clock?.status === 'COUNTDOWN' ? Math.ceil(clock.countdownRemainingMs / 1000) : formatClock(clock?.elapsedMs ?? 0)}
          </div>
        </div>
        <div className="hud-meters">
          <Meter label="Fuel" value={hud?.fuel ?? 0} warn={20} testid="hud-fuel" />
          <Meter label="Health" value={hud?.health ?? 0} warn={30} />
          <Meter label="Tyres" value={hud?.tires ?? 0} warn={30} />
          <Meter label="Nitro" value={hud?.nitro ?? 0} warn={-1} />
        </div>
        <div className="hud-tools">
          <button className="chip" onClick={() => setCam(cams[(cams.indexOf(cam) + 1) % cams.length]!)} data-testid="btn-camera">
            Cam: {cam}
          </button>
          <button className="chip" onClick={() => setQuality(qualities[(qualities.indexOf(quality) + 1) % qualities.length]!)}>
            {quality}
          </button>
          <span className="chip mono nocap" data-testid="fps" data-fps={hud?.fps ?? 0}>
            {hud?.fps ?? 0} fps
          </span>
        </div>
      </div>
      {hud && !hud.released && clock?.status === 'LIVE' && (
        <div className="banner">Cars release at 03:00 — City Sprint. Engines warm.</div>
      )}
      {clock?.status === 'PAUSED' && <div className="banner">Paused by host</div>}
      {hud?.ghost && <div className="banner">Ghosted for repeated ramming — non-collidable for 5 s, clean-driving penalty logged</div>}
      {hud?.canReset && (
        <button className="btn primary reset-btn" onClick={() => props.send({ t: 'reset' })} data-testid="btn-reset">
          Safe reset to lane
        </button>
      )}
      {props.squad && <RacerSquadHud squad={props.squad} hud={hud} />}
      <canvas ref={mapRef} className="minimap" width={240} height={240} data-testid="minimap" aria-label="Map of all squads" />
      <div className="hud-speed" data-testid="hud-speed" data-speed={Math.round(hud?.speed ?? 0)}>
        <span>{Math.round(hud?.speed ?? 0)}</span>
        <small>km/h</small>
      </div>
      <div className="hud-debug mono">
        {props.squadName} · traffic {hud?.traffic ?? 0} · squads near {hud?.others ?? 0} · res ×{(1 / (hud?.scale ?? 1)).toFixed(2)} · corr{' '}
        {(hud?.correction ?? 0).toFixed(2)} m
      </div>
      <div className="controls-left">
        <button className="pad" {...hold('left')} data-testid="btn-left" aria-label="Steer left">◀</button>
        <button className="pad" {...hold('right')} data-testid="btn-right" aria-label="Steer right">▶</button>
      </div>
      <div className="controls-right">
        <div className="pad-col">
          <button className="pad small nitro" {...hold('nitro')} aria-label="Nitro">NOS</button>
          <button className="pad small" {...hold('handbrake')} aria-label="Handbrake">DRIFT</button>
        </div>
        <button className="pad brake" {...hold('brake')} data-testid="btn-brake" aria-label="Brake">BRAKE</button>
        <button className="pad gas" {...hold('throttle')} data-testid="btn-throttle" aria-label="Throttle">GAS</button>
      </div>
    </div>
  );
}

const NET = createTestNetwork();
function waypointNode(squad: SquadView | null) {
  const wp = squad?.waypoint ? WAYPOINTS.find((w) => w.id === squad.waypoint) : null;
  return wp ? NET.nodes[wp.node]! : null;
}

/** Racer's slice of squad play: own private clue, Captain's waypoint arrow, buffs. */
function RacerSquadHud({ squad, hud }: { squad: SquadView; hud: Hud | null }) {
  const clue = squad.challenges.find((c) => c.status === 'open' && c.clue);
  const wp = squad.waypoint ? WAYPOINTS.find((w) => w.id === squad.waypoint) : null;
  return (
    <div className="racer-squad">
      {wp && hud?.wpAngle != null && (
        <div className="wp" data-testid="racer-waypoint">
          <span className="wp-arrow" style={{ transform: `rotate(${hud.wpAngle}rad)` }}>▲</span>
          <span>{wp.label} · {Math.round(hud.wpDist)} m</span>
        </div>
      )}
      {clue && (
        <div className="racer-clue" data-testid="racer-clue">
          <span className="eyebrow">{clue.title} — your clue</span>
          <div>{clue.clue}</div>
        </div>
      )}
      {squad.buffs.map((b) => (
        <span key={b.kind} className="chip">⚡ {b.kind.replace('_', ' ')}</span>
      ))}
    </div>
  );
}

function Meter({ label, value, warn, testid }: { label: string; value: number; warn: number; testid?: string }) {
  return (
    <div className={`meter ${value <= warn ? 'warn' : ''}`} data-testid={testid} data-value={Math.round(value)}>
      <div className="meter-l">
        {label} <b>{Math.round(value)}</b>
      </div>
      <div className="meter-bar">
        <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
