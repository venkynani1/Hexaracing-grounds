import { useCallback, useEffect, useState } from 'react';
import { ROLES, ROLE_LABEL, type ClockState, type Role, type Roster, type ServerMessage, type SessionResponse } from '@redline/shared';
import { api, HttpError } from '../lib/api';
import { navigate } from '../lib/router';
import { clearSession, loadSession, saveSession } from '../lib/session';
import { useWorldSocket } from '../lib/socket';
import { Brand, ClockPanel, Qr, useLiveClock } from '../components';

export function Lobby() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [error, setError] = useState('');

  // Validate the stored session; fall back to the rejoin credential (same slot, new session).
  useEffect(() => {
    const s = loadSession();
    if (!s) return navigate('/', true);
    (async () => {
      try {
        const me = await api.me(s.sessionToken);
        setSession({ ...s, role: me.role, slot: me.slot });
        setRoster(me.roster);
        setClock(me.clock);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) {
          try {
            const fresh = await api.rejoin(s.rejoinToken);
            saveSession(fresh);
            const me = await api.me(fresh.sessionToken);
            setSession(fresh);
            setRoster(me.roster);
            setClock(me.clock);
          } catch {
            clearSession();
            navigate('/', true);
          }
        } else setError('Cannot reach the game server. Retrying…');
      }
    })();
  }, []);

  const onMessage = useCallback((m: ServerMessage) => {
    if (m.t === 'welcome' && m.kind === 'player') {
      setRoster(m.roster);
      setClock(m.clock);
    } else if (m.t === 'roster') setRoster(m.roster);
    else if (m.t === 'clock') setClock(m.clock);
  }, []);
  const { status, offset } = useWorldSocket(session ? { t: 'hello', sessionToken: session.sessionToken } : null, onMessage);
  const live = useLiveClock(clock, offset);

  const me = roster?.players.find((p) => p.playerId === session?.playerId);
  const isCaptain = me?.role === 'CAPTAIN';
  const preStart = clock?.status === 'REGISTRATION_OPEN';
  const joinUrl = roster ? `${location.origin}/join/${roster.joinCode}` : '';

  if (!session || !roster) {
    return (
      <main className="page narrow">
        <Brand small />
        <p className="muted">{error || 'Loading your squad…'}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <Brand small />
        <span className={`conn conn-${status}`} title="Connection to the world server">{status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
      </header>
      <section className="lobby-grid">
        <div className="card">
          <div className="squad-head">
            <div>
              <div className="eyebrow">Squad</div>
              <h1 data-testid="squad-title">{roster.name}</h1>
            </div>
            <div className="code-chip" data-testid="squad-code" aria-label="Squad code">{roster.joinCode}</div>
          </div>
          <ul className="roster" data-testid="roster">
            {[1, 2, 3, 4].map((slot) => {
              const p = roster.players.find((x) => x.slot === slot);
              return (
                <li key={slot} className={p ? 'filled' : 'empty'} data-testid={`slot-${slot}`}>
                  <span className={`dot ${p?.connected ? 'on' : ''}`} />
                  <span className="slot-no">P{slot}</span>
                  <span className="slot-name">{p ? p.displayName : 'Waiting for player…'}</span>
                  {p && <span className={`role-tag role-${p.role.toLowerCase()}`}>{ROLE_LABEL[p.role].split(' — ')[1]}</span>}
                  {p?.playerId === session.playerId && <span className="you">you</span>}
                </li>
              );
            })}
          </ul>
          <div className="squad-status" data-testid="squad-status">
            {roster.full ? 'Squad complete — 4/4 ready' : `${roster.players.length}/4 players`}
          </div>
          {isCaptain && preStart && roster.players.length > 1 && <RoleEditor roster={roster} token={session.sessionToken} onSaved={setRoster} />}
        </div>
        <div className="card center">
          <ClockPanel clock={live} />
          {preStart && !roster.full && (
            <>
              <Qr value={joinUrl} size={180} label="Teammates scan to join" />
              <p className="hint">or enter code <b>{roster.joinCode}</b> at {location.host}</p>
            </>
          )}
          {me && (
            <p className="hint">
              You are <b>{ROLE_LABEL[me.role]}</b>.
              {me.role === 'RACER' ? ' You will drive the squad car.' : me.role === 'CAPTAIN' ? ' You lead navigation, fuel and combined submissions.' : me.role === 'ENGINEER' ? ' You will crack the coding challenges.' : ' You will bluff and detect bluffs.'}
            </p>
          )}
          {clock && (clock.status === 'LIVE' || clock.status === 'COUNTDOWN') && (
            <p className="hint">The 3D world and role consoles arrive in Milestone 2–4. The clock above is the official server clock.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function RoleEditor({ roster, token, onSaved }: { roster: Roster; token: string; onSaved: (r: Roster) => void }) {
  const [draft, setDraft] = useState<Record<string, Role>>(() => Object.fromEntries(roster.players.map((p) => [p.playerId, p.role])));
  const [msg, setMsg] = useState('');
  useEffect(() => setDraft(Object.fromEntries(roster.players.map((p) => [p.playerId, p.role]))), [roster]);
  const changed = roster.players.filter((p) => draft[p.playerId] !== p.role);
  const dupes = new Set(Object.values(draft)).size !== Object.values(draft).length;

  async function save() {
    try {
      const r = await api.assignRoles(token, changed.map((p) => ({ playerId: p.playerId, role: draft[p.playerId]! })));
      onSaved(r.roster);
      setMsg('Roles updated');
    } catch (e) {
      setMsg(e instanceof HttpError ? e.message : 'Failed');
    }
  }

  return (
    <details className="role-editor">
      <summary>Captain: reassign roles</summary>
      {roster.players.map((p) => (
        <label key={p.playerId} className="role-row">
          <span>{p.displayName}</span>
          <select value={draft[p.playerId]} onChange={(e) => setDraft({ ...draft, [p.playerId]: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
      ))}
      {dupes && <div className="error">Each role can only be held once.</div>}
      <button className="btn" disabled={!changed.length || dupes} onClick={save}>
        Save roles
      </button>
      {msg && <span className="hint"> {msg}</span>}
    </details>
  );
}
