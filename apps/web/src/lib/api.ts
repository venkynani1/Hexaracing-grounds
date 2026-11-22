import type { HostOverview, Role, Roster, SessionResponse, SquadPreview, ClockState, StartLocationInfo } from '@redline/shared';

const BASE = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error ?? 'HTTP_ERROR', data.message ?? res.statusText);
  return data as T;
}

export const api = {
  event: () => req<{ eventName: string; clock: ClockState; registrationOpen: boolean; map: 'test' | 'chennai'; worldSeed: string }>('GET', '/api/event'),
  standings: () => req<{ final: boolean; standings: import('@redline/shared').Standing[] }>('GET', '/api/standings'),
  /** Fetch the player's PDF with their bearer token and trigger a browser download. */
  downloadLetter: async (token: string) => {
    const res = await fetch(`${BASE}/api/offer-letter`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpError(res.status, 'LETTER', (await res.json().catch(() => ({}))).message ?? 'Not available');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'code-redline-commemorative-letter.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
  startLocations: () => req<StartLocationInfo[]>('GET', '/api/start-locations'),
  setStartLocation: (token: string, code: string) => req<{ ok: true }>('POST', '/api/team/start-location', { code }, { authorization: `Bearer ${token}` }),
  createSquad: (squadName: string, displayName: string) => req<SessionResponse>('POST', '/api/squads', { squadName, displayName }),
  preview: (code: string) => req<SquadPreview>('GET', `/api/squads/${encodeURIComponent(code)}`),
  join: (code: string, displayName: string, role: Role) => req<SessionResponse>('POST', '/api/squads/join', { code, displayName, role }),
  rejoin: (rejoinToken: string) => req<SessionResponse>('POST', '/api/session/rejoin', { rejoinToken }),
  me: (token: string) =>
    req<{ playerId: string; role: Role; slot: number; roster: Roster; clock: ClockState }>('GET', '/api/me', undefined, {
      authorization: `Bearer ${token}`,
    }),
  assignRoles: (token: string, assignments: { playerId: string; role: Role }[]) =>
    req<{ roster: Roster }>('POST', '/api/team/roles', { assignments }, { authorization: `Bearer ${token}` }),
  squad: {
    coding: (token: string, qid: string, answer: string) => squadPost(token, `/api/squad/coding/${qid}`, { answer, idempotencyKey: idem() }),
    fourKey: (token: string, id: string, answer: string) => squadPost(token, `/api/squad/fourkey/${id}`, { answer, idempotencyKey: idem() }),
    navigation: (token: string, id: string, answer: string) => squadPost(token, `/api/squad/navigation/${id}`, { answer, idempotencyKey: idem() }),
    waypoint: (token: string, waypoint: string | null) => req<{ waypoint: string | null }>('POST', '/api/squad/waypoint', { waypoint }, bearer(token)),
    powerUp: (token: string, kind: string) => req<{ inventory: Record<string, number> }>('POST', '/api/squad/powerup', { kind }, bearer(token)),
    bluffEntry: (token: string, id: string, text: string) => req<{ ok: true }>('POST', `/api/squad/bluff/${id}/entry`, { text }, bearer(token)),
    pitPlan: (token: string, plan: { fuelPct: number; repair: boolean; tyres: boolean }) =>
      req<{ cost: number }>('POST', '/api/squad/pit/plan', plan, bearer(token)),
    pitDiagnose: (token: string, answer: string) => req<{ submitted: true }>('POST', '/api/squad/pit/diagnose', { answer }, bearer(token)),
    pitVerify: (token: string, index: number) => req<{ submitted: true }>('POST', '/api/squad/pit/verify', { index }, bearer(token)),
    pitConfirm: (token: string) => req<{ serviceEndsInMs: number }>('POST', '/api/squad/pit/confirm', {}, bearer(token)),
    rivalDuel: (token: string, answer: string) => req<{ correct: boolean; result: string; points: number }>('POST', '/api/squad/rival/duel', { answer, key: idem() }, bearer(token)),
    rivalOffer: (token: string, give: { kind: string; amount: number }, want: { kind: string; amount: number }) =>
      req<{ offerId: string }>('POST', '/api/squad/rival/offer', { give, want, key: idem() }, bearer(token)),
    rivalRespond: (token: string, offerId: string, accept: boolean) => req<{ status: string; note?: string }>('POST', '/api/squad/rival/respond', { offerId, accept }, bearer(token)),
    rivalDepot: (token: string, option: 'fuel' | 'nitro') => req<{ status: string }>('POST', '/api/squad/rival/depot', { option }, bearer(token)),
    gateEscort: (token: string) => req<{ escorting: true }>('POST', '/api/squad/gate/escort', {}, bearer(token)),
    gateDebug: (token: string, answer: string) => req<{ correct: boolean; digit: number }>('POST', '/api/squad/gate/debug', { answer }, bearer(token)),
    gateAuth: (token: string, index: number) => req<{ correct: boolean; digit: number }>('POST', '/api/squad/gate/auth', { index }, bearer(token)),
    gateCode: (token: string, code: string) => req<SubmitResult>('POST', '/api/squad/gate/code', { code }, bearer(token)),
    bluffVote: (token: string, id: string, choiceId: string) => req<{ ok: true }>('POST', `/api/squad/bluff/${id}/vote`, { choiceId }, bearer(token)),
  },
  host: {
    warp: (key: string, toElapsedMs: number) => req<{ clock: ClockState }>('POST', '/api/host/warp', { toElapsedMs }, { 'x-host-key': key }),
    overview: (key: string) => req<HostOverview>('GET', '/api/host/overview', undefined, { 'x-host-key': key }),
    start: (key: string, force = false) => req<{ clock: ClockState }>('POST', '/api/host/start', { force }, { 'x-host-key': key }),
    pause: (key: string) => req<{ clock: ClockState }>('POST', '/api/host/pause', {}, { 'x-host-key': key }),
    resume: (key: string) => req<{ clock: ClockState }>('POST', '/api/host/resume', {}, { 'x-host-key': key }),
  },
};

export interface SubmitResult {
  correct: boolean;
  points: number;
  attemptsLeft: number;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
/** Fresh idempotency key per user action: a network retry of the same action is never double-scored. */
const idem = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const squadPost = (token: string, path: string, body: unknown) => req<SubmitResult>('POST', path, body, bearer(token));

export function wsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return `${explicit.replace(/\/$/, '')}/ws`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
