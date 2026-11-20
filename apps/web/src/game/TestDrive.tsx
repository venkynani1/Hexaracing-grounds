/**
 * OFFLINE TEST DRIVE — the visual-quality checkpoint. Runs entirely in the browser on the real Chennai road
 * graph (OSM), with the SAME shared vehicle physics and the SAME shared traffic AI the server uses, and the same
 * renderer as the live game. It is clearly labelled and never touches the event world, scoring or the server.
 *
 * URL options: ?q=low|medium|high|ultra  ?rain=1  ?auto=1 (autopilot along the course — recordings/measurements)
 *              ?km=2.2 (start this far before the Hexaware gate)  ?perf=1 (render stats)
 */
import { useEffect, useRef, useState } from 'react';
import {
  NEUTRAL_INPUT,
  Predictor,
  ProceduralBuildings,
  TRAFFIC_TYPES,
  TrafficSystem,
  coursePolyline,
  forwardSpeed,
  initialVehicleState,
  stationExclusions,
  wrapAngle,
  type WorldMap,
} from '@redline/shared';
import { InputState } from './input';
import { drawMap } from './minimap';
import { GameScene, type CameraMode, type Quality } from './scene';
import { autoQuality } from './render/autoQuality';
import { MiniMap, Pedals, RaceClock, Speedo, Toast, Toasts, Announce } from './hud/Hud';
import './hud/hud.css';

const STEP = 0.05;

export default function TestDrive({ map }: { map: WorldMap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const input = useRef(new InputState()).current;
  const params = new URLSearchParams(location.search);
  const [quality, setQuality] = useState<Quality>((params.get('q') as Quality) || autoQuality());
  const [cam, setCam] = useState<CameraMode>((params.get('cam') as CameraMode) || 'chase');
  const [rain, setRain] = useState(params.get('rain') === '1');
  const [hud, setHud] = useState({ speed: 0, fuel: 75, health: 100, tires: 100, nitro: 100, nitroOn: false, fps: 0, t: 0, dist: 0, stats: '' });
  const [loaded, setLoaded] = useState(false);
  const gameRef = useRef<GameScene | null>(null);
  const rainRef = useRef(rain);
  rainRef.current = rain;
  const auto = params.get('auto') === '1';
  const perf = params.get('perf') === '1';

  useEffect(() => {
    const canvas = canvasRef.current!;
    const net = map.net;
    const game = new GameScene(canvas, map, 'test-drive', quality);
    gameRef.current = game;
    if (params.get('color')) game.setPaint('#' + params.get('color'));
    game.setMyCar(params.get('car') ?? 'test-drive-car');
    const fixedRes = params.get('res');
    if (fixedRes) game.lockResolution(Number(fixedRes));
    game.setCameraMode((params.get('cam') as CameraMode) || 'chase');
    void game.ready.then(() => setLoaded(true));
    // Spawn on the real final approach (Rajiv Gandhi Salai / OMR towards Siruseri), N km before the gate.
    const course = Object.values(map.courses)[0]!;
    const pts = coursePolyline(net, course.des);
    const total = pts[pts.length - 1]!.d;
    const km = Number(params.get('km') ?? 2.2);
    let i0 = pts.findIndex((p) => p.d >= total - km * 1000);
    if (i0 < 0) i0 = 0;
    const p0 = pts[i0]!;
    const p1 = pts[Math.min(pts.length - 1, i0 + 2)]!;
    const pb = new ProceduralBuildings(net, 'test-drive', stationExclusions(map));
    const predictor = new Predictor(net, (x, z) => pb.near(x, z, 40));
    predictor.released = true;
    predictor.state = initialVehicleState(p0.x, p0.z, Math.atan2(p1.x - p0.x, p1.z - p0.z), 75);
    predictor.prev = predictor.state;
    // Shared traffic AI on the corridor (both directions where two-way).
    const corridor = new Set<number>();
    for (const de of course.des.slice(Math.max(0, course.des.length - 80))) {
      corridor.add(de);
      if (!net.edges[de >> 1]!.oneway) corridor.add(de ^ 1);
    }
    const traffic = new TrafficSystem(net, { seed: 'test-drive', count: 140, spawnDe: [...corridor] });
    input.attach();
    let simMs = 0;
    let acc = 0;
    let last = performance.now();
    let hudAt = 0;
    let mapAt = 0;
    let started = performance.now();
    let ap = i0;
    const route = course.des.map((de) => {
      const e = net.edges[de >> 1]!;
      return net.nodes[de & 1 ? e.a : e.b]!;
    });
    const autopilot = (): typeof NEUTRAL_INPUT => {
      const s = predictor.state!;
      let best = ap;
      let bd = Infinity;
      for (let j = ap; j < Math.min(pts.length, ap + 60); j++) {
        const d = (pts[j]!.x - s.x) ** 2 + (pts[j]!.z - s.z) ** 2;
        if (d < bd) (bd = d), (best = j);
      }
      ap = best;
      const v = Math.max(0, forwardSpeed(s));
      let j = ap;
      while (j < pts.length - 1 && pts[j]!.d - pts[ap]!.d < 7 + v * 0.6) j++;
      const t = pts[j]!;
      const steer = Math.max(-1, Math.min(1, wrapAngle(Math.atan2(t.x - s.x, t.z - s.z) - s.heading) * 2.2));
      const target = autoTarget(pts, ap, v, traffic.poses(), s);
      return { ...NEUTRAL_INPUT, steer, throttle: v < target ? 0.85 : 0, brake: v > target + 1.5 ? Math.min(1, (v - target) * 0.3) : 0 };
    };
    (window as unknown as { __drive: unknown }).__drive = { predictor, game, traffic };

    game.engine.runRenderLoop(() => {
      const now = performance.now();
      const frameDt = Math.min(0.25, (now - last) / 1000);
      last = now;
      acc += frameDt;
      if (acc > STEP * 5) acc = STEP * 5;
      let inp = { ...NEUTRAL_INPUT };
      predictor.rain = rainRef.current;
      while (acc >= STEP) {
        acc -= STEP;
        simMs += STEP * 1000;
        inp = auto ? autopilot() : input.sample(STEP);
        predictor.step(inp);
        const s = predictor.state!;
        traffic.step(STEP, simMs, [{ x: s.x, z: s.z }]);
        // Simple soft collision with traffic (the live game resolves this on the server).
        for (const t of traffic.poses()) {
          const dx = s.x - t.x;
          const dz = s.z - t.z;
          const d = Math.hypot(dx, dz);
          const r = 1.2 + TRAFFIC_TYPES[t.type].width * 0.5 + (t.type === 'bus' || t.type === 'truck' ? 1.5 : 0.4);
          if (d > 0.01 && d < r) {
            s.x += (dx / d) * (r - d);
            s.z += (dz / d) * (r - d);
            s.vx *= 0.6;
            s.vz *= 0.6;
          }
        }
      }
      const pose = predictor.renderPose(acc / STEP, frameDt)!;
      const s = predictor.state!;
      const fwd = forwardSpeed(s);
      const lat = s.vx * Math.cos(s.heading) - s.vz * Math.sin(s.heading);
      game.setRain(rainRef.current);
      game.updateMe({ x: pose.x, z: pose.z, heading: pose.heading, braking: inp.brake > 0.1, steer: inp.steer, speed: fwd, nitro: inp.nitro && s.nitro > 0, slip: Math.abs(lat) + (inp.handbrake && fwd > 5 ? 3 : 0) });
      game.updateCamera(pose, Math.abs(fwd), frameDt);
      game.updateTraffic(traffic.poses().map((t) => ({ id: t.id, type: TRAFFIC_TYPES[t.type].code, x: t.x, z: t.z, heading: t.heading })));
      game.updateSignals(simMs);
      game.scene.render();
      if (now - mapAt > 300 && mapRef.current) {
        mapAt = now;
        const ctx = mapRef.current.getContext('2d');
        if (ctx) drawMap(ctx, net, [{ id: 'me', x: pose.x, z: pose.z, heading: pose.heading, me: true }], { route, target: map.destination });
      }
      if (now - hudAt > 150) {
        hudAt = now;
        const st = perf ? game.stats() : null;
        setHud({
          speed: Math.abs(fwd) * 3.6,
          fuel: s.fuel,
          health: s.health,
          tires: s.tires,
          nitro: s.nitro,
          nitroOn: inp.nitro,
          fps: Math.round(game.engine.getFps()),
          t: (now - started) / 1000,
          dist: Math.hypot(map.destination.x - s.x, map.destination.z - s.z),
          stats: st ? `draw ${st.drawCalls} · meshes ${st.activeMeshes} · tris ${Math.round(st.activeIndices / 3 / 1000)}k · cells ${st.cells} · res ×${(1 / game.renderScale).toFixed(2)}` : '',
        });
      }
      game.adaptResolution();
    });
    const onResize = () => game.engine.resize();
    window.addEventListener('resize', onResize);
    void started;
    return () => {
      input.detach();
      window.removeEventListener('resize', onResize);
      game.dispose();
      gameRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  useEffect(() => gameRef.current?.setQuality(quality), [quality]);
  useEffect(() => gameRef.current?.setCameraMode(cam), [cam]);

  const qs: Quality[] = ['low', 'medium', 'high', 'ultra'];
  const cams: CameraMode[] = ['chase', 'hood', 'top'];
  const mm = Math.floor(hud.t / 60);
  const ss = Math.floor(hud.t % 60);
  return (
    <div className="rh">
      <canvas ref={canvasRef} className="game-canvas" data-testid="game-canvas" touch-action="none" />
      <div className={`rh-loading ${loaded ? 'done' : ''}`}>Loading car & city…</div>
      <RaceClock phase="Test drive" time={`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`} accent="amber" />
      <div className="rh-tools">
        <button className="rh-chip" onClick={() => setCam(cams[(cams.indexOf(cam) + 1) % cams.length]!)} data-testid="btn-camera">{cam}</button>
        <button className="rh-chip" onClick={() => setQuality(qs[(qs.indexOf(quality) + 1) % qs.length]!)} data-testid="btn-quality">{quality}</button>
        <button className="rh-chip" onClick={() => setRain(!rain)} data-testid="btn-rain">{rain ? 'rain' : 'dry'}</button>
        <span className="rh-chip mono" data-testid="fps" data-fps={hud.fps}>{hud.fps} fps</span>
      </div>
      <MiniMap canvasRef={mapRef} />
      <div className="rh-tag">Offline test drive · not the live event{auto ? ' · autopilot' : ''}</div>
      <Toasts>
        <Toast tone="gold">Hexaware Gate · {(hud.dist / 1000).toFixed(1)} km</Toast>
      </Toasts>
      {rain && <Announce id="rain" text="MONSOON — heavy rain. Grip −20%." expired={false} />}
      <Speedo speed={hud.speed} nitro={hud.nitro} fuel={hud.fuel} health={hud.health} tires={hud.tires} nitroOn={hud.nitroOn} />
      <Pedals input={input} />
      {perf && <div className="rh-debug" data-testid="perf">{hud.stats}</div>}
      <a className="rh-attrib" href="/credits" target="_blank" rel="noreferrer">
        Map © OpenStreetMap contributors (ODbL) · car: Khronos "Car Concept" CC-BY 4.0 · textures/HDRI CC0 — see credits
      </a>
    </div>
  );
}

/** Autopilot target speed: cruise 19 m/s, slow for curvature ahead (reference-driver rule) and for traffic in the lane ahead. */
export function autoTarget(pts: { x: number; z: number; d: number }[], i: number, v: number, traffic: { x: number; z: number; type?: string }[], s: { x: number; z: number; heading: number }) {
  let target = 19;
  const here = pts[i]!.d;
  const horizon = here + Math.max(30, v * 3);
  for (let m = i + 1; m < pts.length - 1 && pts[m]!.d < horizon; m++) {
    const a = pts[m - 1]!, b = pts[m]!, c = pts[m + 1]!;
    const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z)), Math.cos(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z))));
    if (turn > 0.02) {
      const radius = Math.max(1, c.d - a.d) / turn;
      const vCorner = Math.sqrt(8 * 0.7 * radius);
      target = Math.min(target, Math.sqrt(vCorner * vCorner + 2 * 5 * Math.max(0, b.d - here)));
    }
  }
  const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
  for (const t of traffic) {
    const dx = t.x - s.x, dz = t.z - s.z;
    const half = t.type === 'bus' ? 5.5 : t.type === 'truck' ? 4.5 : t.type === 'motorcycle' ? 1.1 : 2.25;
    const ahead = dx * fx + dz * fz - half;
    const lat = Math.abs(dx * fz - dz * fx);
    if (ahead > -half && ahead < 10 + v * 1.6 && lat < 2.4) target = Math.min(target, Math.max(0, (ahead - 6) * 0.45));
  }
  return target;
}
