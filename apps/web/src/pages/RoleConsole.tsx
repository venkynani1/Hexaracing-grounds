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
export function RoleConsole({ view, token, elapsedMs }: { view: SquadView; token: string; elapsedMs: number }) {
  const open = view.challenges.filter((c) => c.status === 'open');
  const upcoming = view.challenges.filter((c) => c.status === 'upcoming');
  const done = view.challenges.filter((c) => c.status === 'closed');
  return (
    <div className="console" data-testid="role-console" data-role={view.role}>
      <div className="console-head">
        <div>
          <div className="eyebrow">{ROLE_LABEL[view.role]} console</div>
          <div className="score-total" data-testid="squad-score">{view.score.total} pts</div>
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
