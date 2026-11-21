import { Suspense, lazy, useState } from 'react';
import { useWorldMap } from '../game/useWorldMap';

const SliceDrive = lazy(() => import('../game/slice/SliceDrive'));

/**
 * /benchmark — Android visual benchmark (OFFLINE: no game server, no multiplayer).
 * Runs the real vertical-slice renderer (`/slice`) with the real licensed assets; every number in the report is
 * measured by PerfProbe on this device. The launcher only builds the query string; the run is a fresh page load.
 */
const SCENES = [
  { id: 'A', label: 'Car + road only', q: 'bench=A&rain=0' },
  { id: 'B', label: 'Car + road + vegetation', q: 'bench=B&rain=0' },
  { id: 'C-dry', label: 'Full environment — dry', q: 'bench=C&rain=0' },
  { id: 'C-rain', label: 'Full environment — rain', q: 'bench=C&rain=1' },
] as const;
const QUALITIES = ['low', 'medium', 'high'] as const;
const MODES = [
  { id: 'auto15', label: 'Automatic 15-min benchmark (autopilot)', q: 'accept=15&auto=1' },
  { id: 'auto3', label: 'Quick 3-min check (autopilot)', q: 'accept=3&auto=1' },
  { id: 'drive15', label: '15-min benchmark — I drive', q: 'accept=15' },
  { id: 'free', label: 'Free drive (live FPS only, no report)', q: '' },
] as const;

export function BenchmarkPage() {
  const run = new URLSearchParams(location.search).get('run') === '1';
  return run ? <BenchmarkRun /> : <Launcher />;
}

function BenchmarkRun() {
  const map = useWorldMap('chennai');
  if (!map) return <div className="page narrow">Loading Chennai map…</div>;
  return (
    <Suspense fallback={<div className="page narrow">Loading renderer…</div>}>
      <SliceDrive map={map} />
    </Suspense>
  );
}

function Launcher() {
  const [scene, setScene] = useState<string>('C-dry');
  const [quality, setQuality] = useState<string>('medium');
  const [mode, setMode] = useState<string>('auto15');
  const sc = SCENES.find((s) => s.id === scene)!;
  const md = MODES.find((m) => m.id === mode)!;
  const href = `/benchmark?run=1&${sc.q}&q=${quality}${md.q ? `&${md.q}` : ''}`;
  return (
    <div className="page narrow bench-launcher" data-testid="benchmark-launcher">
      <h1>Visual benchmark</h1>
      <p className="muted">
        <strong>Offline test mode</strong> — runs on this device only. No game server, no multiplayer, nothing is
        sent anywhere. Uses the real Babylon.js renderer and the real licensed assets of the OMR vertical slice;
        all values are measured on this device.
      </p>
      <fieldset>
        <legend>Scene</legend>
        {SCENES.map((s) => (
          <label key={s.id}>
            <input type="radio" name="scene" checked={scene === s.id} onChange={() => setScene(s.id)} data-testid={`bench-scene-${s.id}`} /> {s.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Graphics</legend>
        {QUALITIES.map((q) => (
          <label key={q}>
            <input type="radio" name="quality" checked={quality === q} onChange={() => setQuality(q)} data-testid={`bench-q-${q}`} /> {q[0]!.toUpperCase() + q.slice(1)}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Run</legend>
        {MODES.map((m) => (
          <label key={m.id}>
            <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} data-testid={`bench-mode-${m.id}`} /> {m.label}
          </label>
        ))}
      </fieldset>
      <a className="btn primary" href={href} data-testid="bench-start">
        Start benchmark
      </a>
      <p className="muted small">
        Before a 15-min run: battery ≥ 50 %, unplugged, battery saver off, Chrome freshly restarted, phone in
        landscape. The report (PASS/FAIL against median ≥ 30 FPS, 1 % low ≥ 24, p95 ≤ 40 ms, no stalls &gt; 250 ms)
        appears at the end with Copy / Download JSON. Live FPS and frame time are shown top-right throughout.
      </p>
    </div>
  );
}
