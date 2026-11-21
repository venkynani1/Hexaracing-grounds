import { useEffect, useState, type FormEvent } from 'react';
import { BALANCE, ROLES, ROLE_LABEL, normalizeJoinCode, type Role, type SquadPreview } from '@redline/shared';
import { api, HttpError } from '../lib/api';
import { navigate } from '../lib/router';
import { loadSession, saveSession } from '../lib/session';
import { Brand } from '../components';

export function Home({ initialCode }: { initialCode: string }) {
  const [mode, setMode] = useState<'create' | 'join'>(initialCode ? 'join' : 'create');
  const [name, setName] = useState('');
  const [squadName, setSquadName] = useState('');
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<SquadPreview | null>(null);
  const [role, setRole] = useState<Role | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = loadSession();

  useEffect(() => {
    const norm = normalizeJoinCode(code);
    setPreview(null);
    if (!norm) return;
    let cancelled = false;
    api.preview(norm).then(
      (p) => {
        if (cancelled) return;
        setPreview(p);
        setRole((r) => (r && p.freeRoles.includes(r) ? r : (p.freeRoles[0] ?? '')));
        setError('');
      },
      (e: HttpError) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const s =
        mode === 'create'
          ? await api.createSquad(squadName, name)
          : await api.join(normalizeJoinCode(code) ?? code, name, role as Role);
      saveSession(s);
      navigate('/lobby');
    } catch (e) {
      setError(e instanceof HttpError ? e.message : 'Network error — check your connection');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <Brand />
      {import.meta.env.PROD && !import.meta.env.VITE_SERVER_URL && (
        <div className="card notice" data-testid="no-server-notice">
          <strong>Live multiplayer server is not connected to this deployment.</strong> Squads, lobby and the live race
          need the game server (VITE_SERVER_URL). For the 3D driving experience on this device, use the{' '}
          <a href="/benchmark">offline benchmark</a> or the <a href="/test-drive">offline test drive</a>.
        </div>
      )}
      {existing && (
        <button className="btn ghost wide" onClick={() => navigate('/lobby')} data-testid="resume-session">
          Return to my squad lobby
        </button>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'tab active' : 'tab'} onClick={() => setMode('create')}>
          Create squad
        </button>
        <button role="tab" aria-selected={mode === 'join'} className={mode === 'join' ? 'tab active' : 'tab'} onClick={() => setMode('join')}>
          Join with code
        </button>
      </div>
      <form className="card" onSubmit={submit}>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={BALANCE.displayNameMax} autoComplete="nickname" required data-testid="display-name" />
        </label>
        {mode === 'create' ? (
          <>
            <label>
              Squad name
              <input value={squadName} onChange={(e) => setSquadName(e.target.value)} maxLength={BALANCE.squadNameMax} required data-testid="squad-name" />
            </label>
            <p className="hint">You start as <b>P4 — Captain</b>. You can reassign roles in the lobby before the host starts.</p>
          </>
        ) : (
          <>
            <label>
              Squad code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={8}
                className="code-input"
                autoCapitalize="characters"
                autoComplete="off"
                required
                data-testid="join-code"
              />
            </label>
            {preview && (
              <div className="preview" data-testid="squad-preview">
                <div>
                  Joining <b>{preview.name}</b>
                </div>
                {preview.full ? (
                  <div className="error">This squad is full.</div>
                ) : (
                  <fieldset className="roles">
                    <legend>Choose your role</legend>
                    {ROLES.map((r) => (
                      <label key={r} className={preview.freeRoles.includes(r) ? 'role-opt' : 'role-opt taken'}>
                        <input
                          type="radio"
                          name="role"
                          value={r}
                          disabled={!preview.freeRoles.includes(r)}
                          checked={role === r}
                          onChange={() => setRole(r)}
                          data-testid={`role-${r}`}
                        />
                        {ROLE_LABEL[r]}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            )}
          </>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary wide" disabled={busy || (mode === 'join' && (!preview || preview.full || !role))} data-testid="submit">
          {busy ? '…' : mode === 'create' ? 'Create squad' : 'Join squad'}
        </button>
      </form>
    </main>
  );
}
