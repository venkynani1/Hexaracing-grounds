import { useState } from 'react';
import {
  POWER_UPS,
  ROLE_LABEL,
  SCORING_CAPS,
  formatClock,
  type ChallengeView,
  type PowerUpKind,
  type ScoringCategory,
  type SquadView,
  type WorldState,
  type PitView,
} from '@redline/shared';
import { api, HttpError, type SubmitResult } from '../lib/api';

const CATEGORY_LABEL: Record<ScoringCategory, string> = {
  DRIVING: 'Driving',
  CODING: 'Coding',
  DECEPTION: 'Deception',
  CAPTAIN_STRATEGY: 'Strategy',
  TEAM_ASSESSMENTS: 'Team',
  FUEL_MANAGEMENT: 'Fuel',
  HEXAWARE_GATE: 'Gate',
};

/** Engineer / Deceiver / Captain console. Everything shown comes from this player's role-filtered server view. */
export function RoleConsole({ view, token, elapsedMs, world }: { view: SquadView; token: string; elapsedMs: number; world: WorldState | null }) {
  const open = view.challenges.filter((c) => c.status === 'open');
  const upcoming = view.challenges.filter((c) => c.status === 'upcoming');
  const done = view.challenges.filter((c) => c.status === 'closed');
  return (
    <div className="console" data-testid="role-console" data-role={view.role}>
      <div className="console-head">
        <div>
          <div className="eyebrow">{ROLE_LABEL[view.role]} console</div>
          <div className="score-total" data-testid="squad-score">{view.score.total} pts</div>
          <div className="hint" data-testid="credits">Garage credits: <b>{view.credits}</b></div>
        </div>
        <div className="cat-grid">
          {(Object.keys(CATEGORY_LABEL) as ScoringCategory[]).map((c) => (
            <span key={c} title={`${CATEGORY_LABEL[c]} (max ${SCORING_CAPS[c]})`}>
              {CATEGORY_LABEL[c]} <b>{view.score.byCategory[c]}</b>
            </span>
          ))}
        </div>
      </div>
      {view.buffs.length > 0 && (
        <div className="buffs">
          {view.buffs.map((b) => (
            <span key={b.kind} className="chip">⚡ {b.kind.replace('_', ' ')} {Math.ceil(b.remainingMs / 1000)}s</span>
          ))}
        </div>
      )}
      {world?.announcement && elapsedMs - world.announcement.atMs < 60_000 && (
        <div className="announce-card" data-testid="announcement">
          <b>Director:</b> {world.announcement.text}
        </div>
      )}
      {world && (world.rain || world.closures.length > 0 || world.fuelPriceMul !== 1) && (
        <div className="hint world-line" data-testid="world-status">
          {world.rain && '🌧 Rain: grip −20% · '}
          {world.closures.map((c) => `⛔ Closed: ${c.label} · `)}
          {world.fuelPriceMul !== 1 && `⛽ Fuel ×${world.fuelPriceMul}`}
        </div>
      )}
      {view.pit && view.pit.stage !== 'done' && <PitCard pit={view.pit} role={view.role} token={token} />}
      {view.role === 'CAPTAIN' && <CaptainPanel view={view} token={token} />}
      {open.length === 0 && <p className="hint">No challenge is open right now. Next: {upcoming[0] ? `${upcoming[0].title} at ${formatClock(upcoming[0].opensAt)}` : '—'}</p>}
      {open.map((c) => (
        <ChallengeCard key={c.id} c={c} token={token} elapsedMs={elapsedMs} />
      ))}
      {done.length > 0 && (
        <details className="done">
          <summary>Finished challenges ({done.length})</summary>
          {done.map((c) => (
            <ChallengeCard key={c.id} c={c} token={token} elapsedMs={elapsedMs} />
          ))}
        </details>
      )}
      {upcoming.length > 0 && (
        <ul className="upcoming">
          {upcoming.map((c) => (
            <li key={c.id}>
              <span className="mono">{formatClock(c.opensAt)}</span> {c.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useSubmit() {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<SubmitResult | unknown>, describe?: (r: SubmitResult) => string) => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fn();
      if (describe && r && typeof r === 'object' && 'correct' in r) setMsg(describe(r as SubmitResult));
      else setMsg('Submitted');
    } catch (e) {
      setMsg(e instanceof HttpError ? e.message : 'Network error');
    } finally {
      setBusy(false);
    }
  };
  return { msg, busy, run };
}

const describeResult = (r: SubmitResult) =>
  r.correct ? `Correct! +${r.points}` : r.attemptsLeft > 0 ? `Not quite — ${r.attemptsLeft} attempt${r.attemptsLeft > 1 ? 's' : ''} left` : 'Incorrect — no attempts left';

function ChallengeCard({ c, token, elapsedMs }: { c: ChallengeView; token: string; elapsedMs: number }) {
  const left = Math.max(0, (c.phase === 'write' ? c.writeUntil ?? c.closesAt : c.closesAt) - elapsedMs);
  return (
    <section className={`challenge ch-${c.kind} ${c.status}`} data-testid={`challenge-${c.id}`}>
      <header>
        <b>{c.title}</b>
        {c.status === 'open' && <span className="mono timer">{formatClock(left)}</span>}
        {c.points ? <span className="pts">+{c.points}</span> : null}
      </header>
      {c.kind === 'coding' && <Coding c={c} token={token} />}
      {c.kind === 'four_key' && <FourKey c={c} token={token} />}
      {c.kind === 'navigation' && <Navigation c={c} token={token} />}
      {c.kind === 'bluff' && <Bluff c={c} token={token} />}
    </section>
  );
}

function Coding({ c, token }: { c: ChallengeView; token: string }) {
  if (c.action !== 'answer') {
    const solved = c.questions?.filter((q) => q.solved).length ?? 0;
    return <p className="hint">Engineer progress: {solved}/{c.questions?.length ?? 0} solved.</p>;
  }
  return (
    <div className="questions">
      {c.questions!.map((q, i) => (
        <CodingQuestion key={q.id} q={q} index={i} token={token} />
      ))}
    </div>
  );
}

function CodingQuestion({ q, index, token }: { q: NonNullable<ChallengeView['questions']>[number]; index: number; token: string }) {
  const [answer, setAnswer] = useState('');
  const { msg, busy, run } = useSubmit();
  const locked = q.solved || q.attempts >= q.maxAttempts;
  const submit = (a: string) => run(() => api.squad.coding(token, q.id, a), describeResult);
  return (
    <div className="question" data-testid={`question-${index + 1}`}>
      <div className="q-prompt">
        Q{index + 1}. {q.prompt} {q.solved && <span className="pts">✓ +{q.points}</span>}
      </div>
      <pre className="code">{q.code}</pre>
      {!locked &&
        (q.options ? (
          <div className="opts">
            {q.options.map((o) => (
              <button key={o} className="btn opt" disabled={busy} onClick={() => submit(o)}>
                {o}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(answer);
            }}
          >
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Output" autoCapitalize="off" autoComplete="off" />
            <button className="btn primary" disabled={busy || !answer.trim()}>Submit</button>
          </form>
        ))}
      <div className="hint" data-testid={`question-${index + 1}-result`}>
        {msg || (locked && !q.solved ? 'No attempts left' : `${q.maxAttempts - q.attempts} attempt(s) left`)}
      </div>
    </div>
  );
}

function FourKey({ c, token }: { c: ChallengeView; token: string }) {
  const [answer, setAnswer] = useState('');
  const { msg, busy, run } = useSubmit();
  return (
    <div>
      <p>{c.prompt}</p>
      {c.clue && (
        <div className="clue" data-testid={`clue-${c.id}`}>
          <span className="eyebrow">Your private clue — tell your Captain</span>
          <div>{c.clue}</div>
        </div>
      )}
      {c.action === 'submit' && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.squad.fourKey(token, c.id, answer), describeResult);
          }}
        >
          <input value={answer} onChange={(e) => setAnswer(e.target.value.toUpperCase())} placeholder="Combined answer" data-testid={`fourkey-input-${c.id}`} autoComplete="off" />
          <button className="btn primary" disabled={busy || !answer.trim()} data-testid={`fourkey-submit-${c.id}`}>
            Submit
          </button>
        </form>
      )}
      <div className="hint" data-testid={`fourkey-result-${c.id}`}>
        {msg || (c.solved ? `Solved ✓ +${c.points}` : `Attempts: ${c.attempts}/${c.maxAttempts}`)}
      </div>
    </div>
  );
}

function Navigation({ c, token }: { c: ChallengeView; token: string }) {
  const { msg, busy, run } = useSubmit();
  return (
    <div>
      <p>{c.prompt}</p>
      {c.action === 'answer' && (
        <div className="opts">
          {c.options!.map((o) => (
            <button key={o} className="btn opt" disabled={busy} onClick={() => run(() => api.squad.navigation(token, c.id, o), describeResult)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="hint">{msg || (c.solved ? `Solved ✓ +${c.points}` : `Attempts: ${c.attempts}/${c.maxAttempts}`)}</div>
    </div>
  );
}

function Bluff({ c, token }: { c: ChallengeView; token: string }) {
  const [text, setText] = useState('');
  const { msg, busy, run } = useSubmit();
  return (
    <div>
      <p className="bluff-prompt">“{c.prompt}”</p>
      {c.phase === 'write' && c.action === 'write' && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.squad.bluffEntry(token, c.id, text));
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={60} placeholder="Write a convincing fake answer" data-testid={`bluff-input-${c.id}`} />
          <button className="btn primary" disabled={busy || !text.trim()} data-testid={`bluff-submit-${c.id}`}>
            Bluff
          </button>
        </form>
      )}
      {c.myEntry && <p className="hint" data-testid={`bluff-entry-${c.id}`}>Your squad’s bluff: “{c.myEntry}”</p>}
      {c.phase === 'write' && c.action === 'view' && !c.myEntry && <p className="hint">Deceivers are writing bluffs…</p>}
      {c.phase === 'vote' && c.action === 'vote' && (
        <div className="opts">
          <p className="hint">Which one is the REAL answer? (Your own squad’s bluff is hidden.)</p>
          {c.bluffOptions!.map((o) => (
            <button key={o.choiceId} className="btn opt" disabled={busy} onClick={() => run(() => api.squad.bluffVote(token, c.id, o.choiceId))}>
              {o.text}
            </button>
          ))}
        </div>
      )}
      {c.phase === 'vote' && c.myVote && <p className="hint">Vote locked in.</p>}
      {c.results && (
        <p data-testid={`bluff-results-${c.id}`}>
          Real answer: <b>{c.results.truth}</b>. {c.results.detected ? 'Detected ✓. ' : ''}Your bluff fooled {c.results.myTeamFooled}. +{c.results.points}
        </p>
      )}
      {msg && <div className="hint">{msg}</div>}
    </div>
  );
}

/** Steps 2–5 of the pit stop, by role. */
function PitCard({ pit, role, token }: { pit: PitView; role: SquadView['role']; token: string }) {
  const { msg, busy, run } = useSubmit();
  const [fuel, setFuel] = useState(pit.plan?.fuelPct ?? 30);
  const [repair, setRepair] = useState(pit.plan?.repair ?? false);
  const [tyres, setTyres] = useState(pit.plan?.tyres ?? false);
  const inBay = pit.stage === 'in_bay';
  const est = Math.round(fuel * pit.prices.fuelPerPct + (tyres ? pit.prices.tyres : 0));
  return (
    <section className="challenge open" data-testid="pit-card">
      <header>
        <b>Pit stop — {pit.stationName}</b>
        {pit.dwellLeftMs != null && <span className="mono timer">{Math.ceil(pit.dwellLeftMs / 1000)}s</span>}
      </header>
      <p className="hint">
        {pit.stage === 'queued' ? `Queued (position ${pit.queuePosition}). Bays are FIFO.` : pit.stage === 'servicing' ? 'Servicing… the car rejoins the road when done.' : `In bay ${pit.bay! + 1}. Max 60 s — unconfirmed stops get an automatic refuel.`}
      </p>
      {role === 'CAPTAIN' && inBay && (
        <div className="pit-plan">
          <label className="role-row">
            Fuel +{fuel}% <input type="range" min={0} max={70} step={5} value={fuel} onChange={(e) => setFuel(Number(e.target.value))} data-testid="pit-fuel" />
          </label>
          <label className="role-row">
            <span>Repair body (to 100%)</span> <input type="checkbox" checked={repair} onChange={(e) => setRepair(e.target.checked)} data-testid="pit-repair" />
          </label>
          <label className="role-row">
            <span>New tyres ({pit.prices.tyres} cr)</span> <input type="checkbox" checked={tyres} onChange={(e) => setTyres(e.target.checked)} data-testid="pit-tyres" />
          </label>
          <div className="hint">≈ {est}+ credits (fuel {pit.prices.fuelPerPct.toFixed(1)}/%)</div>
          <div className="opts wrap">
            <button className="btn" disabled={busy} onClick={() => run(() => api.squad.pitPlan(token, { fuelPct: fuel, repair, tyres }))} data-testid="pit-select">
              2 · Select services
            </button>
            <button className="btn primary" disabled={busy || !pit.steps.select} onClick={() => run(() => api.squad.pitConfirm(token))} data-testid="pit-confirm">
              5 · Confirm
            </button>
          </div>
        </div>
      )}
      {role === 'ENGINEER' && inBay && pit.diagnostics && (
        <div>
          <div className="eyebrow">3 · Diagnostics — which system is out of spec?</div>
          <ul className="readings">
            {pit.diagnostics.readings.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {!pit.diagnostics.chosen ? (
            <div className="opts wrap">
              {pit.diagnostics.options.map((o) => (
                <button key={o} className="btn opt" disabled={busy} onClick={() => run(() => api.squad.pitDiagnose(token, o))}>
                  {o}
                </button>
              ))}
            </div>
          ) : (
            <p className="hint">Reported to Captain: {pit.diagnostics.chosen}</p>
          )}
        </div>
      )}
      {role === 'DECEIVER' && inBay && pit.reports && (
        <div>
          <div className="eyebrow">4 · One mechanic report is FALSE — which?</div>
          {pit.reports.chosen === null ? (
            <div className="opts">
              {pit.reports.items.map((r, i) => (
                <button key={r} className="btn opt" disabled={busy} onClick={() => run(() => api.squad.pitVerify(token, i))}>
                  {r}
                </button>
              ))}
            </div>
          ) : (
            <p className="hint">Flagged: {pit.reports.items[pit.reports.chosen]}</p>
          )}
        </div>
      )}
      <div className="pit-steps">
        {(['enter', 'select', 'diagnose', 'verify', 'confirm', 'release'] as const).map((k, i) => (
          <span key={k} className={pit.steps[k] ? 'done' : ''}>
            {i + 1}. {k}
          </span>
        ))}
      </div>
      {msg && <div className="hint">{msg}</div>}
    </section>
  );
}

function CaptainPanel({ view, token }: { view: SquadView; token: string }) {
  const { msg, busy, run } = useSubmit();
  return (
    <section className="challenge captain" data-testid="captain-panel">
      <header>
        <b>Strategy</b>
      </header>
      <div className="eyebrow">Navigation — sets the Racer’s waypoint</div>
      <div className="opts wrap">
        {view.waypoints.map((w) => (
          <button key={w.id} className={`btn opt ${view.waypoint === w.id ? 'selected' : ''}`} disabled={busy} onClick={() => run(() => api.squad.waypoint(token, w.id))} data-testid={`wp-${w.id}`}>
            {w.label}
          </button>
        ))}
      </div>
      <div className="eyebrow">Power-ups — deployed on the real car</div>
      <div className="opts wrap">
        {(Object.keys(POWER_UPS) as PowerUpKind[]).map((k) => (
          <button key={k} className="btn opt" disabled={busy || view.inventory[k] <= 0} onClick={() => run(() => api.squad.powerUp(token, k))} title={POWER_UPS[k].description} data-testid={`pu-${k}`}>
            {POWER_UPS[k].label} ×{view.inventory[k]}
          </button>
        ))}
      </div>
      {msg && <div className="hint">{msg}</div>}
    </section>
  );
}
