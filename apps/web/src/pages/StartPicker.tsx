import { useEffect, useState } from 'react';
import type { StartLocationInfo } from '@redline/shared';
import { api, HttpError } from '../lib/api';

/**
 * Start location: the Captain chooses before START (SPEC 2.1). Only verified locations with free capacity are
 * selectable. Every course is calibrated to the same reference time — the "via" list discloses how.
 */
export function StartPicker({ token, current, canEdit }: { token: string; current: string | null; canEdit: boolean }) {
  const [list, setList] = useState<StartLocationInfo[] | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.startLocations().then((l) => alive && setList(l), () => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [current]);
  if (!list) return null;
  const mine = list.find((l) => l.code === current);
  const pick = async (code: string) => {
    setBusy(true);
    setMsg('');
    try {
      await api.setStartLocation(token, code);
      setList(await api.startLocations());
    } catch (e) {
      setMsg(e instanceof HttpError ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="start-picker" data-testid="start-picker">
      <div className="eyebrow">Start location {canEdit ? '— Captain chooses' : ''}</div>
      {mine ? (
        <p data-testid="start-current">
          <b>{mine.name}</b> → Hexaware · {mine.courseKm} km{mine.via.length ? ` via ${mine.via.join(' → ')}` : ''}
        </p>
      ) : (
        <p className="hint">{canEdit ? 'Pick where your squad starts.' : 'Not chosen yet — unchosen squads are assigned the least-used location at START.'}</p>
      )}
      {canEdit && (
        <div className="opts wrap">
          {list.map((l) => (
            <button
              key={l.code}
              className={`btn opt ${l.code === current ? 'selected' : ''}`}
              disabled={busy || (!l.selectable && l.code !== current)}
              onClick={() => pick(l.code)}
              title={l.verified ? `${l.courseKm} km course${l.via.length ? ' via ' + l.via.join(' → ') : ''}` : l.reason}
              data-testid={`start-${l.code}`}
            >
              {l.name} <small>{l.verified ? `${l.taken}/${l.capacity}` : 'unverified'}</small>
            </button>
          ))}
        </div>
      )}
      {msg && <div className="error">{msg}</div>}
      <p className="hint">All courses take the same reference time (±10%); shorter natural routes are extended through the listed landmarks, never shortcut.</p>
    </div>
  );
}
