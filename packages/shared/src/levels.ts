/**
 * The five game levels, mapped onto the existing server timeline (phases in timeline.ts stay the persisted IDs, so
 * recovery snapshots and stored event_states remain compatible). The Director advances them automatically from the
 * single host START; nothing here is client-authoritative.
 */
const MIN = 60_000;

export interface Level {
  n: 1 | 2 | 3 | 4 | 5;
  id: 'DECODE_DRIVE' | 'BUILD_BOOST' | 'INFILTRATE_OUTSMART' | 'TRADE_COLLABORATE' | 'FINAL_CIRCUIT';
  title: string;
  purpose: string;
  startMs: number;
  endMs: number;
  /** existing phase IDs covered by this level */
  phases: string[];
}

export const LEVELS: readonly Level[] = [
  { n: 1, id: 'DECODE_DRIVE', title: 'Decode & Drive', purpose: 'Decode clues, drive the first checkpoints', startMs: 3 * MIN, endMs: 10 * MIN, phases: ['CITY_SPRINT'] },
  { n: 2, id: 'BUILD_BOOST', title: 'Build & Boost', purpose: 'Engineering, fuel and the four-key system puzzle', startMs: 10 * MIN, endMs: 24 * MIN, phases: ['TRAFFIC_TACTICS', 'FUEL_CRISIS'] },
  { n: 3, id: 'INFILTRATE_OUTSMART', title: 'Infiltrate & Outsmart', purpose: 'Intelligence, bluffing and navigation decoding', startMs: 24 * MIN, endMs: 33 * MIN, phases: ['UNKNOWN_ZONE'] },
  { n: 4, id: 'TRADE_COLLABORATE', title: 'Trade & Collaborate', purpose: 'Rival duels and Captain-approved trades', startMs: 33 * MIN, endMs: 42 * MIN, phases: ['REDLINE_OVERDRIVE'] },
  { n: 5, id: 'FINAL_CIRCUIT', title: 'Final Circuit', purpose: 'Every skill combined on the final approach', startMs: 42 * MIN, endMs: 50 * MIN, phases: ['FINAL_APPROACH'] },
];

/** Event stage label for any elapsed time (levels, plus departure and the Hexaware finale around them). */
export function stageAt(elapsedMs: number): { level: Level | null; label: string } {
  const level = LEVELS.find((l) => elapsedMs >= l.startMs && elapsedMs < l.endMs) ?? null;
  if (level) return { level, label: `Level ${level.n} · ${level.title}` };
  if (elapsedMs < LEVELS[0]!.startMs) return { level: null, label: 'Chennai Departure' };
  if (elapsedMs < 55 * MIN) return { level: null, label: 'Hexaware Gate' };
  if (elapsedMs < 58 * MIN) return { level: null, label: 'Welcome Convoy' };
  return { level: null, label: 'Championship Reveal' };
}

/* ---------------------------------------------------------------- Level 4: rivals */

export const RIVAL = {
  duelOpensAt: 33 * MIN,
  duelClosesAt: 37 * MIN,
  tradeClosesAt: 42 * MIN,
  duelMaxAttempts: 2,
  points: { duelWin: 30, duelSecond: 10, duelSolo: 20, trade: 10, depot: 5 },
  /** bounds per offer; fuel never drops a squad below fuelFloor (no stranding) */
  limits: { credits: [10, 150] as const, fuel: [5, 25] as const, nitro: [1, 1] as const, fuelFloor: 10, openOffers: 3, offerTtlMs: 90_000 },
  depot: { fuel: { credits: 60, fuel: 15 }, nitro: { credits: 40, nitro: 1 } },
} as const;

export type TradeKind = 'credits' | 'fuel' | 'nitro';
export interface TradeItem {
  kind: TradeKind;
  amount: number;
}
export interface TradeOfferView {
  id: string;
  from: 'us' | 'them';
  give: TradeItem;
  want: TradeItem;
  status: 'open' | 'accepted' | 'declined' | 'expired' | 'failed';
  note?: string;
  expiresInMs: number;
}
export interface RivalView {
  window: 'upcoming' | 'duel' | 'trade' | 'closed';
  duelOpensAt: number;
  duelClosesAt: number;
  tradeClosesAt: number;
  /** null = solo route this round (odd squad count): a fair solo duel and the depot */
  partner: { teamId: string; name: string } | null;
  duel: {
    /** question only for the Captain (who submits); other roles see a status line */
    prompt: string;
    options: string[] | null;
    attempts: number;
    maxAttempts: number;
    result: 'pending' | 'won' | 'second' | 'solo' | 'lost' | 'failed';
    points: number;
    partnerSolved: boolean;
  } | null;
  trade: { offers: TradeOfferView[]; completed: boolean; depotUsed: boolean; canAct: boolean };
}
