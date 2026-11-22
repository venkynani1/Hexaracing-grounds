import { useEffect, useRef, useState } from 'react';
import {
  CAR_FLAG_GHOST,
  Interpolator,
  type ClockState,
  type ConvoyTimeline,
  type Standing,
  type WorldMap,
} from '@redline/shared';
import { GameScene } from './scene';
import { autoQuality } from './render/autoQuality';
import type { WorldFeed } from './RacerView';

/**
 * Welcome Convoy + Championship Reveal (SPEC Part 15/16). Every phone, the host and the projector render the SAME
 * convoy: the real squad cars at their server positions (map channel, 5 Hz), following one shared timeline.
 */
export default function Finale(props: {
  map: WorldMap;
  seed: string;
  clock: ClockState | null;
  offset: number;
  subscribe: (fn: (m: WorldFeed) => void) => () => void;
  timeline: ConvoyTimeline | null;
  standings: Standing[] | null;
  myTeamId?: string;
  onDownloadLetter?: () => Promise<void>;
  /** projector: show the replay control */
  projector?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [err, setErr] = useState('');
  const [letterMsg, setLetterMsg] = useState('');
  // Championship reveal: results are locked server-side; this only paces the presentation.
  // 0 final transmission → 1 places 11+ → 2 places 4–10 → 3 third → 4 second → 5 champion + members → 6 full board
  const [step, setStep] = useState(0);
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    if (!props.standings) return;
    setStep(0);
    const id = setInterval(() => setStep((x) => Math.min(6, x + 1)), 4000);
    return () => clearInterval(id);
  }, [props.standings, replay]);

  useEffect(() => {
    let game: GameScene;
    try {
      game = new GameScene(canvas.current!, props.map, props.seed, autoQuality());
    } catch (e) {
      setErr(`3D not available: ${(e as Error).message}`);
      return;
    }
    const cars = new Interpolator<{ id: number; x: number; z: number; heading: number; name: string; teamId: string }>(250);
    const unsub = props.subscribe((m) => {
      if (m.t === 'map') cars.push(m.serverTime, m.cars.map(([cid, teamId, name, x, z, h]) => ({ id: cid, teamId, name, x, z, heading: h })));
    });
    game.startCelebration();
    const t0 = performance.now();
    game.engine.runRenderLoop(() => {
      const t = (performance.now() - t0) / 1000;
      const now = Date.now() + propsRef.current.offset;
      const list = cars.sample(now);
      game.updateOthers(list.map((c) => ({ ...c, colorKey: c.teamId, label: c.name, ghost: false, braking: false })));
      // Follow the convoy lead (order 0 in the timeline), or the centroid.
      const leadCid = propsRef.current.timeline?.slots.find((s) => s.order === 0)?.cid;
      const lead = list.find((c) => c.id === leadCid) ?? list[0];
      if (lead) game.cinematic(lead.x, lead.z, t);
      game.tickCelebration(t);
      game.scene.render();
    });
    const onResize = () => game.engine.resize();
    window.addEventListener('resize', onResize);
    return () => {
      unsub();
      window.removeEventListener('resize', onResize);
      game.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.map, props.seed]);
  void CAR_FLAG_GHOST;

  const squads = props.timeline?.slots.length ?? 0;
  const mine = props.standings?.find((s) => s.teamId === props.myTeamId);
  return (
    <div className="finale" data-testid="finale">
      <canvas ref={canvas} className="game-canvas" />
      {err && <div className="racer-error">{err}</div>}
      <div className="finale-text">
        <div data-testid="finale-line-1">
          {squads || 30} SQUAD{squads === 1 ? '' : 'S'}.
        </div>
        <div>{(squads || 30) * 4} PLAYERS.</div>
        <div>ONE DESTINATION.</div>
        <div className="welcome">WELCOME TO HEXAWARE.</div>
      </div>
      {props.timeline && (
        <div className="finale-note">
          Welcome Convoy — all {props.timeline.slots.length} real squad car{props.timeline.slots.length === 1 ? '' : 's'}, one timeline.{' '}
          {props.timeline.slots.filter((s) => s.assisted).length > 0 && `${props.timeline.slots.filter((s) => s.assisted).length} squad(s) joined via disclosed assisted entry.`}
        </div>
      )}
      {props.standings && (
        <div className="podium" data-testid="podium">
          <h2>Championship</h2>
          <div className="reveal" data-testid="reveal" data-step={step}>
            {step === 0 && <div className="reveal-big">FINAL TRANSMISSION — results locked</div>}
            {step === 1 && (
              <div className="reveal-group">
                {props.standings.filter((x) => x.rank > 10).map((x) => (
                  <span key={x.teamId}>
                    #{x.rank} {x.name} · {x.total}
                  </span>
                ))}
              </div>
            )}
            {step === 2 && (
              <div className="reveal-group">
                {props.standings.filter((x) => x.rank >= 4 && x.rank <= 10).map((x) => (
                  <span key={x.teamId}>
                    #{x.rank} {x.name} · {x.total}
                  </span>
                ))}
              </div>
            )}
            {step >= 3 && step <= 5 && (() => {
              const r = step === 3 ? 3 : step === 4 ? 2 : 1;
              const t = props.standings!.find((y) => y.rank === r);
              return t ? (
                <div className={`reveal-big place-${r}`} data-testid={`reveal-place-${r}`}>
                  {r === 1 ? 'CHAMPIONS' : r === 2 ? 'SECOND PLACE' : 'THIRD PLACE'}: {t.name} · {t.total}
                  {r === 1 && t.members?.length ? <div className="reveal-members">{t.members.join(' · ')}</div> : null}
                </div>
              ) : null;
            })()}
            {props.projector && (
              <button className="btn ghost" onClick={() => setReplay((n) => n + 1)} data-testid="reveal-replay">
                Replay reveal
              </button>
            )}
          </div>
          <ol>
            {props.standings.slice(0, 10).map((s) => (
              <li key={s.teamId} className={s.teamId === props.myTeamId ? 'me' : ''}>
                <span className="rank">{s.rank}</span> {s.name} <b>{s.total}</b>
              </li>
            ))}
          </ol>
          {mine && (
            <p data-testid="my-result">
              Your squad: #{mine.rank} · {mine.total} pts
            </p>
          )}
          {props.onDownloadLetter && (
            <button
              className="btn primary"
              data-testid="download-letter"
              onClick={async () => {
                setLetterMsg('Preparing…');
                try {
                  await props.onDownloadLetter!();
                  setLetterMsg('Downloaded ✓');
                } catch (e) {
                  setLetterMsg((e as Error).message);
                }
              }}
            >
              Download your commemorative letter (PDF)
            </button>
          )}
          {letterMsg && <span className="hint" data-testid="letter-msg"> {letterMsg}</span>}
        </div>
      )}
    </div>
  );
}
