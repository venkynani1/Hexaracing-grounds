/**
 * /slice — the visual vertical slice: ~800 m of the real Rajiv Gandhi Salai (OMR) at the Taramani junction,
 * playable with the SAME shared vehicle physics and the SAME shared traffic AI as the event server. Offline and
 * clearly labelled; it never touches the event world, scoring or the database.
 *
 * Acceptance-test mode (run on the reference phone):  /slice?accept=15            → you drive, 15 min
 *                                                      /slice?accept=15&auto=1     → autopilot drives
 * Records median/1%-low FPS, p95 frame time, stalls, long tasks, memory, download size, FPS + resolution timeline
 * (thermal), battery, device/browser info; weather toggles every 90 s; evaluates the pass/fail gate on screen.
 */
import { Color3 } from '@babylonjs/core';
import { useEffect, useRef, useState } from 'react';
import {
  NEUTRAL_INPUT,
  Predictor,
  TrafficSystem,
  forwardSpeed,
  initialVehicleState,
  lanePoint,
  wrapAngle,
  type VehicleInput,
  type WorldMap,
} from '@redline/shared';
import { InputState } from '../input';
import { Announce, MiniMap, Pedals, RaceClock, Speedo, Toast, Toasts } from '../hud/Hud';
import { PerfProbe, type ProbeReport } from '../perf/probe';
import { detectGpu } from '../render/autoQuality';
import { buildCorridor, type Corridor } from './corridor';
import { SliceScene, type SliceQuality } from './SliceScene';
import '../hud/hud.css';

const STEP = 0.05;
const TRAFFIC_COLOURS = ['#e8e8e4', '#b5b7bb', '#1c1c1f', '#8b1010', '#20386e', '#6d675d'].map((h) => Color3.FromHexString(h).toLinearSpace());

interface Gate {
  pass: boolean;
  checks: { name: string; ok: boolean; value: string; need: string }[];
}

function evaluate(r: ProbeReport, minutes: number, scaleTimeline: number[]): Gate {
  const tl = r.fpsTimeline;
  const first = tl.slice(0, 18);
  const last = tl.slice(-18);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const thermalRatio = first.length && last.length ? avg(last) / avg(first) : 1;
  const scaleDrift = scaleTimeline.length > 2 ? scaleTimeline[scaleTimeline.length - 1]! / scaleTimeline[0]! : 1;
  const checks = [
    { name: 'Median FPS', ok: r.medianFps >= 30, value: String(r.medianFps), need: '≥ 30' },
    { name: '1% low FPS', ok: r.low1Fps >= 24, value: String(r.low1Fps), need: '≥ 24' },
    { name: 'p95 frame time', ok: r.p95FrameMs <= 40, value: `${r.p95FrameMs} ms`, need: '≤ 40 ms' },
    { name: 'Stalls > 250 ms', ok: r.stallsOver250ms === 0, value: `${r.stallsOver250ms} (max ${r.maxFrameMs} ms)`, need: '0' },
    { name: 'Duration', ok: r.durationS >= minutes * 60 - 5, value: `${(r.durationS / 60).toFixed(1)} min`, need: `≥ ${minutes} min` },
    { name: 'Thermal (last 3 min / first 3 min FPS)', ok: thermalRatio >= 0.85 && scaleDrift < 1.35, value: `${(thermalRatio * 100).toFixed(0)}% · res drift ×${scaleDrift.toFixed(2)}`, need: '≥ 85%, res drift < ×1.35' },
    { name: 'No crash', ok: true, value: 'page alive', need: 'completes' },
  ];
  return { pass: checks.every((c) => c.ok), checks };
}

async function deviceInfo() {
  const nav = navigator as Navigator & {
    userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> };
    deviceMemory?: number;
    getBattery?: () => Promise<{ level: number; charging: boolean }>;
  };
  let hints: Record<string, unknown> = {};
  try {
    hints = (await nav.userAgentData?.getHighEntropyValues(['model', 'platform', 'platformVersion', 'fullVersionList'])) ?? {};
  } catch {
    /* not available */
  }
  let battery: { level: number; charging: boolean } | null = null;
  try {
    const b = await nav.getBattery?.();
    if (b) battery = { level: Math.round(b.level * 100), charging: b.charging };
  } catch {
    /* not available */
  }
  return {
    model: (hints.model as string) || null,
    platform: (hints.platform as string) || null,
    platformVersion: (hints.platformVersion as string) || null,
    browser: ((hints.fullVersionList as { brand: string; version: string }[]) ?? []).map((b) => `${b.brand} ${b.version}`).join(', ') || null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    battery,
    userAgent: navigator.userAgent,
  };
}

export default function SliceDrive({ map }: { map: WorldMap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const input = useRef(new InputState()).current;
  const params = new URLSearchParams(location.search);
  const acceptMin = Number(params.get('accept') ?? 0);
  const auto = params.get('auto') === '1';
  const [quality, setQuality] = useState<SliceQuality>((params.get('q') as SliceQuality) || 'medium');
  const [rain, setRain] = useState(params.get('rain') === '1');
  const [load, setLoad] = useState({ p: 0, label: 'Loading' });
  const [hud, setHud] = useState({ speed: 0, fuel: 75, health: 100, tires: 100, nitro: 100, nitroOn: false, fps: 0, t: 0, toGo: 800, note: '' });
  const [result, setResult] = useState<{ report: ProbeReport; gate: Gate; device: unknown; build: unknown } | null>(null);
  const [progress, setProgress] = useState('');
  const rainRef = useRef(rain);
  rainRef.current = rain;

  useEffect(() => {
    let cor: Corridor;
    try {
      cor = buildCorridor(map, 180);
    } catch (e) {
      setLoad({ p: 0, label: (e as Error).message });
      return;
    }
    const t0 = performance.now();
    const game = new SliceScene(canvasRef.current!, map, cor, quality);
    const res = params.get('res');
    if (res) game.lockResolution(Number(res));
    game.setHero(Color3.FromHexString('#c8102e').toLinearSpace());
    (window as unknown as { __slice: unknown }).__slice = { game, cor };
    let readyAt = 0;
    const probe = new PerfProbe(game.scene, game.engine, () => readyAt - t0);
    let alive = true;
    let predictor: Predictor | null = null;
    let traffic: TrafficSystem | null = null;
    const net = map.net;
    // lane polylines of the drive path (lane 0 = kerb side … 2 = median side)
    const lanes = [0, 1, 2].map((lane) => {
      const out: { x: number; z: number; d: number }[] = [];
      let d = 0;
      for (const de of cor.path) {
        const e = net.edges[de >> 1]!;
        const n = Math.max(1, Math.ceil(e.length / 4));
        for (let i = 0; i <= n; i++) {
          const p = lanePoint(net, de, Math.min(lane, e.lanes - 1), (e.length * i) / n);
          const prev = out[out.length - 1];
          if (prev) d += Math.hypot(p.x - prev.x, p.z - prev.z);
          if (!prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 0.5) out.push({ x: p.x, z: p.z, d });
        }
      }
      return out;
    });
    // signalised stop line on the path
    let stopD = -1;
    let stopNode = -1;
    let stopHeading = 0;
    {
      let d = 0;
      for (const de of cor.path) {
        const e = net.edges[de >> 1]!;
        d += e.length;
        const to = de & 1 ? e.a : e.b;
        if (net.nodes[to]!.signal && stopD < 0) {
          stopD = d - Math.min(net.nodes[to]!.radius, e.length * 0.45);
          stopNode = to;
          const from = net.nodes[de & 1 ? e.b : e.a]!;
          stopHeading = Math.atan2(net.nodes[to]!.x - from.x, net.nodes[to]!.z - from.z);
        }
      }
    }
    const reset = (why: string) => {
      if (!predictor) return;
      predictor.state = initialVehicleState(cor.start.x, cor.start.z, cor.start.heading, predictor.state?.fuel ?? 75);
      predictor.state.vx = Math.sin(cor.start.heading) * 12;
      predictor.state.vz = Math.cos(cor.start.heading) * 12;
      predictor.prev = predictor.state;
      apIdx = 0;
      note = why;
      noteUntil = performance.now() + 3000;
    };
    let note = '';
    let noteUntil = 0;
    let apIdx = 0;
    let apLane = 1;
    let apLaneF = 1;

    const autopilot = (simMs: number): VehicleInput => {
      const s = predictor!.state!;
      const pts = lanes[apLane]!;
      let best = apIdx;
      let bd = Infinity;
      for (let j = Math.max(0, apIdx - 5); j < Math.min(pts.length, apIdx + 60); j++) {
        const d = (pts[j]!.x - s.x) ** 2 + (pts[j]!.z - s.z) ** 2;
        if (d < bd) (bd = d), (best = j);
      }
      apIdx = best;
      const here = pts[apIdx]!.d;
      const v = Math.max(0, forwardSpeed(s));
      // overtake: slower traffic ahead in my lane → move to a free neighbour lane
      const fx = Math.sin(s.heading);
      const fz = Math.cos(s.heading);
      let ahead = Infinity;
      const laneBlocked = (lf: number) => {
        let m = Infinity;
        for (const t of traffic!.poses()) {
          const dx = t.x - s.x;
          const dz = t.z - s.z;
          const along = dx * fx + dz * fz;
          const lat = dx * fz - dz * fx;
          const myLat = (lf - apLaneF) * net.laneWidth;
          if (along > -6 && along < 45 && Math.abs(-lat - myLat) < 2) m = Math.min(m, along);
        }
        return m;
      };
      ahead = laneBlocked(apLane);
      if (ahead < 30) {
        for (const cand of [apLane + 1, apLane - 1]) if (cand >= 0 && cand <= 2 && laneBlocked(cand) > 40) (apLane = cand);
      }
      apLaneF += Math.sign(apLane - apLaneF) * Math.min(Math.abs(apLane - apLaneF), STEP * 0.6);
      const tgtPts = lanes[Math.round(apLaneF)]!;
      let j = Math.min(apIdx, tgtPts.length - 1);
      while (j < tgtPts.length - 1 && tgtPts[j]!.d - here < 7 + v * 0.6) j++;
      const tg = tgtPts[j]!;
      const steer = Math.max(-1, Math.min(1, wrapAngle(Math.atan2(tg.x - s.x, tg.z - s.z) - s.heading) * 2.2));
      let target = 17;
      // curvature
      for (let m = apIdx + 1; m < pts.length - 1 && pts[m]!.d < here + Math.max(30, v * 3); m++) {
        const a = pts[m - 1]!;
        const b = pts[m]!;
        const c = pts[m + 1]!;
        const turn = Math.abs(wrapAngle(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z)));
        if (turn > 0.02) target = Math.min(target, Math.sqrt(Math.sqrt(5.6 * (Math.max(1, c.d - a.d) / turn)) ** 2 + 10 * Math.max(0, b.d - here)));
      }
      if (ahead < 40) target = Math.min(target, Math.max(0, (ahead - 7) * 0.45));
      // signal: brake for red/amber before the stop line
      if (stopD > 0 && here < stopD && stopD - here < 70) {
        const col = game.signalAt(stopNode, stopHeading, simMs);
        if (col !== 'G' && stopD - here > 3) target = Math.min(target, Math.max(0, (stopD - here - 4) * 0.4));
      }
      return { ...NEUTRAL_INPUT, steer, throttle: v < target ? 0.8 : 0, brake: v > target + 1 ? Math.min(1, (v - target) * 0.35) : 0, nitro: false };
    };

    void game
      .load((p, label) => setLoad({ p, label }))
      .then(async () => {
        if (!alive) return;
        const pb = game.pb!;
        predictor = new Predictor(net, (x, z) => pb.near(x, z, 40));
        predictor.released = true;
        reset('');
        note = '';
        // six licensed traffic cars on the slice's carriageways, shared IDM traffic AI
        const spawn: number[] = [];
        for (const id of cor.edges) {
          const e = net.edges[id]!;
          if (e.cls > 2) continue;
          spawn.push(id * 2);
          if (!e.oneway) spawn.push(id * 2 + 1);
        }
        traffic = new TrafficSystem(net, { seed: 'slice', count: 8, spawnDe: cor.path, mix: { car: 0.7, bus: 0.3 } });
        void spawn;
        readyAt = performance.now();
        setLoad({ p: 1, label: 'Ready' });
        start();
      });

    const start = () => {
      input.attach();
      let simMs = 0;
      let acc = 0;
      let last = performance.now();
      let hudAt = 0;
      let mapAt = 0;
      let rainAt = performance.now();
      let probeStart = 0;
      let finished = false;
      const scaleTl: number[] = [];
      let lastScaleAt = 0;
      let inp: VehicleInput = { ...NEUTRAL_INPUT };
      const route = cor.pts.map((p) => ({ x: p.x, z: p.z }));
          if (acceptMin > 0) setTimeout(() => ((probeStart = performance.now()), probe.begin()), 5000);
      game.engine.runRenderLoop(() => {
        const now = performance.now();
        const frameDt = Math.min(0.25, (now - last) / 1000);
        last = now;
        acc = Math.min(acc + frameDt, STEP * 5);
        const p = predictor!;
        p.rain = rainRef.current;
        while (acc >= STEP) {
          acc -= STEP;
          simMs += STEP * 1000;
          inp = auto ? autopilot(simMs) : input.sample(STEP);
          p.step(inp);
          const s = p.state!;
          traffic!.step(STEP, simMs, [{ x: s.x, z: s.z }]);
          for (const t of traffic!.poses()) {
            const dx = s.x - t.x;
            const dz = s.z - t.z;
            const d = Math.hypot(dx, dz);
            const rr = t.type === 'bus' ? 4.2 : 2.4;
            if (d > 0.01 && d < rr) {
              s.x += (dx / d) * (rr - d);
              s.z += (dz / d) * (rr - d);
              s.vx *= 0.6;
              s.vz *= 0.6;
            }
          }
          // keep the six cars around the player: anything far behind or outside the slice is recycled onto the
          // drive path 60–260 m ahead (out of sight in the haze), so there is always traffic to drive through
          {
            let myD = 0;
            let bd = Infinity;
            for (const q of cor.pts) {
              const d = (q.x - s.x) ** 2 + (q.z - s.z) ** 2;
              if (d < bd) (bd = d), (myD = q.d);
            }
            const fx = Math.sin(s.heading);
            const fz = Math.cos(s.heading);
            for (const a of traffic!.agents) {
              const pose = traffic!.pose(a);
              const behind = (pose.x - s.x) * fx + (pose.z - s.z) * fz < -60;
              const out = Math.hypot(pose.x - cor.center.x, pose.z - cor.center.z) > cor.radius - 60;
              if (!behind && !out) continue;
              const want = myD + 60 + ((a.id * 37 + Math.floor(simMs / 1000)) % 200);
              let acc2 = 0;
              let de = cor.path[cor.path.length - 1]!;
              let sOn = 5;
              for (const d of cor.path) {
                const L = net.edges[d >> 1]!.length;
                if (acc2 + L > want) {
                  de = d;
                  sOn = Math.max(2, want - acc2);
                  break;
                }
                acc2 += L;
              }
              if (want > cor.length - 20) continue; // nothing ahead to place on: leave it
              const lane = a.id % net.edges[de >> 1]!.lanes;
              Object.assign(a, { de, s: Math.min(sOn, net.edges[de >> 1]!.length - 1), lane, laneF: lane, conn: null, speed: 10 + (a.id % 3) * 2 });
            }
          }
          // end of slice / left the slice → disclosed reset to the start
          const fromStart = Math.hypot(s.x - cor.pts[cor.pts.length - 1]!.x, s.z - cor.pts[cor.pts.length - 1]!.z);
          if (fromStart < 18) reset('End of slice — lap restart (disclosed)');
          else if (Math.hypot(s.x - cor.center.x, s.z - cor.center.z) > cor.radius - 140) reset('Left the slice — back to the start (disclosed)');
        }
        const pose = p.renderPose(acc / STEP, frameDt)!;
        const s = p.state!;
        const fwd = forwardSpeed(s);
        const lat = s.vx * Math.cos(s.heading) - s.vz * Math.sin(s.heading);
        game.setRain(rainRef.current);
        game.updateMe({ x: pose.x, z: pose.z, heading: pose.heading, braking: inp.brake > 0.1, steer: inp.steer, speed: fwd, nitro: inp.nitro && s.nitro > 0, slip: Math.abs(lat) + (inp.handbrake && fwd > 5 ? 3 : 0) });
        game.updateCamera(pose, Math.abs(fwd), frameDt);
        const poses = traffic!.poses();
        game.updateTraffic(poses.filter((t) => t.type === 'car').map((t) => ({ id: t.id, x: t.x, z: t.z, heading: t.heading, braking: t.speed < 2, color: TRAFFIC_COLOURS[t.id % TRAFFIC_COLOURS.length]! })));
        game.updateBuses(poses.filter((t) => t.type !== 'car'));
        game.updateSignals(simMs);
        game.scene.render();
        game.adaptResolution();
        if (acceptMin > 0 && probeStart) {
          if (now - rainAt > 90_000) (rainAt = now), setRain((r) => !r);
          if (now - lastScaleAt > 10_000) (lastScaleAt = now), scaleTl.push(+game.renderScale.toFixed(2));
          const el = (now - probeStart) / 1000;
          if (!finished && el >= acceptMin * 60) {
            finished = true;
            const report = probe.end(`slice ${game.quality}${auto ? ' autopilot' : ' manual'}`, { quality: game.quality, renderScale: +(1 / game.renderScale).toFixed(2), gpu: detectGpu() });
            void deviceInfo().then((device) => {
              const r = { report, gate: evaluate(report, acceptMin, scaleTl), device, build: { ...game.stats, scaleTimeline: scaleTl } };
              (window as unknown as { __accept: unknown }).__accept = r;
              setResult(r);
            });
          } else if (!finished && Math.floor(el) % 5 === 0) setProgress(`Acceptance run: ${Math.floor(el / 60)}:${String(Math.floor(el % 60)).padStart(2, '0')} / ${acceptMin}:00`);
        }
        if (now - mapAt > 400 && mapRef.current) {
          mapAt = now;
          const ctx = mapRef.current.getContext('2d');
          if (ctx) drawLocal(ctx, cor, pose, traffic!.poses(), map);
        }
        if (now - hudAt > 150) {
          hudAt = now;
          const end = cor.pts[cor.pts.length - 1]!;
          setHud({
            speed: Math.abs(fwd) * 3.6,
            fuel: s.fuel,
            health: s.health,
            tires: s.tires,
            nitro: s.nitro,
            nitroOn: inp.nitro,
            fps: Math.round(game.engine.getFps()),
            t: (now - readyAt) / 1000,
            toGo: Math.hypot(end.x - s.x, end.z - s.z),
            note: now < noteUntil ? note : '',
          });
        }
      });
      void route;
    };
    const onResize = () => game.engine.resize();
    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      input.detach();
      window.removeEventListener('resize', onResize);
      game.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, quality]);

  const qs: SliceQuality[] = ['low', 'medium', 'high'];
  const mm = Math.floor(hud.t / 60);
  const ss = Math.floor(hud.t % 60);
  return (
    <div className="rh">
      <canvas ref={canvasRef} className="game-canvas" data-testid="game-canvas" touch-action="none" />
      <div className={`rh-loading ${load.p >= 1 ? 'done' : ''}`} data-testid="slice-loading">
        {load.label} · {Math.round(load.p * 100)}%
      </div>
      <RaceClock phase="OMR slice" time={`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`} accent="amber" />
      <div className="rh-tools">
        {!acceptMin && (
          <button className="rh-chip" onClick={() => setQuality(qs[(qs.indexOf(quality) + 1) % qs.length]!)} data-testid="btn-quality">
            {quality}
          </button>
        )}
        <button className="rh-chip" onClick={() => setRain(!rain)} data-testid="btn-rain">
          {rain ? 'rain' : 'dry'}
        </button>
        <span className="rh-chip mono" data-testid="fps" data-fps={hud.fps}>
          {hud.fps} fps
        </span>
      </div>
      <MiniMap canvasRef={mapRef} />
      <div className="rh-tag">Vertical slice · Rajiv Gandhi Salai (OMR), Taramani · offline{auto ? ' · autopilot' : ''}</div>
      <Toasts>
        <Toast tone="gold">Slice end · {Math.round(hud.toGo)} m</Toast>
        {hud.note && <Toast tone="warn">{hud.note}</Toast>}
        {progress && !result && <Toast tone="info">{progress}</Toast>}
      </Toasts>
      {rain && <Announce id="rain" text="MONSOON — heavy rain. Grip −20%." expired={false} />}
      <Speedo speed={hud.speed} nitro={hud.nitro} fuel={hud.fuel} health={hud.health} tires={hud.tires} nitroOn={hud.nitroOn} />
      <Pedals input={input} />
      {result && <ResultPanel r={result} />}
      <a className="rh-attrib" href="/credits" target="_blank" rel="noreferrer">
        Map © OpenStreetMap contributors (ODbL) · car: Khronos "Car Concept" CC-BY 4.0 · textures/HDRI CC0 — credits
      </a>
    </div>
  );
}

function ResultPanel({ r }: { r: { report: ProbeReport; gate: Gate; device: unknown; build: unknown } }) {
  const json = JSON.stringify(r, null, 1);
  return (
    <div className="slice-result" data-testid="accept-result" data-pass={r.gate.pass}>
      <h2 className={r.gate.pass ? 'ok' : 'bad'}>{r.gate.pass ? 'PASS' : 'FAIL'} — performance gate</h2>
      <table>
        <tbody>
          {r.gate.checks.map((c) => (
            <tr key={c.name} className={c.ok ? 'ok' : 'bad'}>
              <td>{c.ok ? '✓' : '✕'}</td>
              <td>{c.name}</td>
              <td>{c.value}</td>
              <td>{c.need}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="slice-result-actions">
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(json)}>Copy JSON</button>
        <a className="btn" download="slice-acceptance.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(json)}`}>
          Download JSON
        </a>
      </div>
      <pre>{json}</pre>
    </div>
  );
}

/** Local route map: the slice's roads, your car (red) and traffic (white). */
function drawLocal(ctx: CanvasRenderingContext2D, cor: Corridor, me: { x: number; z: number; heading: number }, cars: { x: number; z: number }[], map: WorldMap) {
  const W = ctx.canvas.width;
  const s = W / (cor.radius * 1.4);
  const px = (x: number) => W / 2 + (x - me.x) * s;
  const pz = (z: number) => W / 2 - (z - me.z) * s;
  ctx.fillStyle = '#0d1016';
  ctx.fillRect(0, 0, W, W);
  ctx.lineCap = 'round';
  for (const id of cor.edges) {
    const e = map.net.edges[id]!;
    const a = map.net.nodes[e.a]!;
    const b = map.net.nodes[e.b]!;
    ctx.strokeStyle = e.cls <= 2 ? '#5b6577' : '#363d4a';
    ctx.lineWidth = Math.max(2, e.halfWidth * s * 1.6);
    ctx.beginPath();
    ctx.moveTo(px(a.x), pz(a.z));
    ctx.lineTo(px(b.x), pz(b.z));
    ctx.stroke();
  }
  ctx.strokeStyle = '#38c8ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  cor.pts.forEach((p, i) => (i ? ctx.lineTo(px(p.x), pz(p.z)) : ctx.moveTo(px(p.x), pz(p.z))));
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  for (const c of cars) ctx.fillRect(px(c.x) - 3, pz(c.z) - 3, 6, 6);
  ctx.save();
  ctx.translate(W / 2, W / 2);
  ctx.rotate(me.heading);
  ctx.fillStyle = '#ff3b4f';
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(6, 7);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
