# CODE REDLINE — Event-day checklist

One page for the host. Server = GitHub Codespace `psychic-space-chainsaw` (port 2567). Web = https://code-redline.vercel.app.
Projector = `/projector`, host dashboard = `/host` (both need the host key). Details and incident table: `docs/RUNBOOK.md`.

## The day before
- [ ] **New event name + private seed.** In the codespace terminal:
      `cd /workspaces/Hexaracing-grounds && git pull && npm install && EVENT_NAME="Hexa Racing Grounds" bash .devcontainer/start-server.sh`
      A NEW name creates a clean event (test squads stay in the old one) with a random private seed (answers cannot be
      derived from the public repository). The name is remembered in `~/.redline/event-name`, so later restarts are
      just `bash .devcontainer/start-server.sh` and stay on the same event.
- [ ] Ports tab → **2567 → Public**. Check from a phone on mobile data (not Wi-Fi) in a private tab:
      `https://psychic-space-chainsaw-v6v79jxpwxg7hwgg9-2567.app.github.dev/api/health` → `{"ok":true,"db":true,…}`
- [ ] GitHub → Settings → Codespaces → **Default idle timeout: 240 minutes** (the codespace stops when idle).
- [ ] Web deploy matches the server commit (Vercel → Deployments → latest = same commit as `git log -1` in the codespace).
- [ ] Projector laptop: open `/projector`, enter the host key, check it is readable from the back of the room.
- [ ] Phone check on mobile data: open the site, Create squad "TEST" → it appears on the projector lobby.
      Do this on a throwaway event name (e.g. `EVENT_NAME="Hexa Racing Grounds TEST"`), then restart with
      `EVENT_NAME="Hexa Racing Grounds"` so the real event starts clean.

## 60 minutes before
- [ ] Codespace open in a browser tab on the host laptop (keeps it awake). Laptop on power, sleep disabled.
- [ ] `/host` shows: DB OK, tick ≈ 20 Hz, clients count rising as people join.
- [ ] Participants use their OWN mobile data: ask them to arrive with data on and ≥ 100 MB left (see data use below).
- [ ] Projector on `/projector` (lobby screen lists squads as they register).

## Registration (≈ 20 min)
- [ ] Show the site URL / QR on the projector. Each squad's Captain creates the squad, 3 teammates join with the code.
- [ ] Every squad must have exactly 4 players before START (lobby shows `n/4 players`; START stays disabled until
      all squads are full — **Force start** exists but is audit-logged).
- [ ] Racers: phone in landscape or portrait, graphics **Medium** (Low on old phones), screen timeout ≥ 10 min.

## START
- [ ] Host dashboard → **START** (once). Countdown, then the Director runs everything: 5 levels, events, gate, convoy,
      championship reveal at 58:00. Do not refresh the host page during the countdown.

## During the event — watch `/host`
| See | Do |
|---|---|
| Phones drop briefly | Nothing — they rejoin their slot automatically. |
| Something wrong in the room | **Emergency pause**, fix, **Resume**. Clock and puzzles freeze exactly. |
| Server restarted / codespace woke up | Run `bash .devcontainer/start-server.sh` (name is remembered); it comes back **PAUSED** from the last 10 s snapshot; check `/host`, **Resume**. |
| DB DOWN > 1 min | Pause; check Neon dashboard; resume when OK. |
| Squad stuck | Racer taps "Safe reset" (auto after 6 s). |
| Port shows 401 to phones | Ports tab → 2567 → Public again. |

## After
- [ ] Offer letters: each player downloads from their phone (`COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER`).
      PDFs download per player only. `GET <server>/api/host/offer-letters` (header `x-host-key`) lists every issued
      letter (player, achievement, score, arrival) as JSON — there is no bulk PDF download.
- [ ] Leave the codespace running 30 min for late downloads, then stop it (free hours).

## Never on event day
- `ALLOW_TIME_WARP=true` (rehearsal only) · reusing the public default seed · passing a different `EVENT_NAME` mid-event ·
  pasting `DATABASE_URL` / host key anywhere public.
