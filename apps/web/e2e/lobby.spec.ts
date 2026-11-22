import { expect, test, type Browser, type Page } from '@playwright/test';
import { HOST_KEY, SERVER_URL } from '../playwright.config';

test.describe.configure({ mode: 'serial' });
let racerPage: Page;
let squadPages: { captain: Page; racer: Page; engineer: Page; deceiver: Page };

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

test('M1: scan → create squad → 3 contexts join → all see full lobby → host can START', async ({ browser }) => {
  // Captain scans the registration QR (lands on /) and creates a squad.
  const captain = await newPage(browser);
  await captain.goto('/');
  await captain.getByTestId('display-name').fill('Asha');
  await captain.getByTestId('squad-name').fill('Redline Rookies');
  await captain.getByTestId('submit').click();
  await expect(captain).toHaveURL(/\/lobby$/);
  const code = (await captain.getByTestId('squad-code').innerText()).trim();
  expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  await expect(captain.getByTestId('slot-4')).toContainText('Asha');

  // Three teammates scan the squad QR (/join/CODE) in separate browser contexts.
  const members: [string, string][] = [
    ['Ravi', 'RACER'],
    ['Esha', 'ENGINEER'],
    ['Dev', 'DECEIVER'],
  ];
  const pages: Page[] = [captain];
  for (const [name, role] of members) {
    const p = await newPage(browser);
    await p.goto(`/join/${code}`);
    await expect(p.getByTestId('squad-preview')).toContainText('Redline Rookies');
    await p.getByTestId('display-name').fill(name);
    await p.getByTestId(`role-${role}`).check();
    await p.getByTestId('submit').click();
    await expect(p).toHaveURL(/\/lobby$/);
    pages.push(p);
  }

  // All four see the complete roster, live over the shared WebSocket.
  for (const p of pages) {
    await expect(p.getByTestId('squad-status')).toHaveText('Squad complete — 4/4 ready');
    for (const [slot, name] of [[1, 'Ravi'], [2, 'Esha'], [3, 'Dev'], [4, 'Asha']] as const) {
      await expect(p.getByTestId(`slot-${slot}`)).toContainText(name);
    }
    await expect(p.locator('[data-testid="roster"] .dot.on')).toHaveCount(4);
  }

  // M5: the Captain picks a verified start location; every teammate sees the disclosed course.
  await captain.getByTestId('start-kelambakkam').click();
  for (const p of pages) await expect(p.getByTestId('start-current')).toContainText('Kelambakkam');
  await expect(pages[1]!.getByTestId('start-kelambakkam')).toHaveCount(0); // only the Captain can choose

  // Host dashboard shows the squad and enables START.
  const host = await newPage(browser);
  await host.goto('/host');
  await host.getByTestId('host-key').fill(HOST_KEY);
  await host.getByTestId('host-login').click();
  await expect(host.getByTestId('squad-row')).toHaveCount(1);
  await expect(host.getByTestId('squad-row')).toContainText('Redline Rookies');
  await expect(host.getByTestId('squad-row')).toContainText(code);
  await expect(host.getByTestId('stat-players')).toHaveText('4/120');
  await expect(host.getByTestId('start')).toBeEnabled();

  // Press START: every non-racer lobby sees the shared countdown; the racer's phone loads the 3D world.
  await host.getByTestId('start').click();
  for (const p of [captain, pages[2]!, pages[3]!]) await expect(p.getByTestId('clock')).toHaveAttribute('data-status', /COUNTDOWN|LIVE/);
  await expect(host.getByTestId('clock')).toHaveAttribute('data-status', /COUNTDOWN|LIVE/);
  racerPage = pages[1]!;
  squadPages = { captain, racer: pages[1]!, engineer: pages[2]!, deceiver: pages[3]! };
});

test('M2: racer view renders the world, FPS > 0, touch input moves the car on the server', async ({ request }) => {
  const p = racerPage;
  await expect(p.getByTestId('game-canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Number(await p.getByTestId('fps').getAttribute('data-fps')), { timeout: 20_000 }).toBeGreaterThan(0);
  const canvasSize = await p.getByTestId('game-canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  expect(canvasSize[0]).toBeGreaterThan(0);

  const world = async () => (await request.get(`${SERVER_URL}/api/host/world`, { headers: { 'x-host-key': HOST_KEY } })).json();
  await expect.poll(async () => (await world()).released, { timeout: 15_000 }).toBe(true);
  const before = (await world()).cars[0];

  // Hold the on-screen GAS pad (touch/pointer), steer a little right.
  const gas = p.getByTestId('btn-throttle');
  await gas.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true });
  await p.waitForTimeout(2500);
  await gas.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true });

  const after = (await world()).cars[0];
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  expect(moved).toBeGreaterThan(5);
  await expect.poll(async () => Number(await p.getByTestId('hud-speed').getAttribute('data-speed'))).toBeGreaterThanOrEqual(0);
  await expect(p.getByTestId('minimap')).toBeVisible();
  await p.screenshot({ path: 'test-results/racer-view.png' });

  // Host dashboard shows the live map of the one world with the real squad car on it.
  const host = await (await p.context().browser()!.newContext()).newPage();
  await host.goto('/host');
  await host.getByTestId('host-key').fill(HOST_KEY);
  await host.getByTestId('host-login').click();
  await expect(host.getByTestId('host-map')).toBeVisible({ timeout: 10_000 });
  await expect(host.getByText(/1 squad cars/)).toBeVisible();
  await expect(host.getByTestId('host-map-attribution')).toContainText('OpenStreetMap contributors');
});

test('M5: Chennai course guidance + OSM attribution in-game and in credits', async ({ browser }) => {
  const p = racerPage;
  await expect(p.getByTestId('osm-attribution')).toContainText('© OpenStreetMap contributors');
  await expect(p.getByTestId('osm-attribution')).toContainText('ODbL');
  await expect(p.getByTestId('checkpoint-guide')).toContainText(/Checkpoint \d+\/10/);
  // area recognisability: real area name (OSM place) at the car, e.g. "Park Town" near Chennai Central
  await expect(p.getByTestId('location')).toBeVisible({ timeout: 15_000 });
  await expect(p.getByTestId('location')).toContainText(/[A-Z][a-z]+/);
  await p.screenshot({ path: 'test-results/m5-racer.png' });
  const c = await (await browser.newContext()).newPage();
  await c.goto('/credits');
  await expect(c.getByTestId('credits')).toContainText('© OpenStreetMap contributors');
  await expect(c.getByTestId('credits')).toContainText('Open Database License (ODbL) 1.0');
  await expect(c.getByTestId('credits')).toContainText('85% scale');
});

/** Decode the four private clues exactly as teammates would read them out to their Captain. */
function decodeFourKey(c: { RACER: string; ENGINEER: string; DECEIVER: string; CAPTAIN: string }): string {
  const plus = c.RACER.match(/plus (\d+)/);
  if (plus) {
    const [, k, j] = c.ENGINEER.match(/power (\d+), minus (\d+)/)!.map(Number) as [number, number, number];
    const w = c.DECEIVER.match(/“(.+)”/)![1]!.length;
    const [, m, n] = c.CAPTAIN.match(/(\d+) × 3, minus (\d+)/)!.map(Number) as [number, number, number];
    return `${Number(plus[1]) + 2}${2 ** k - j}${w}${3 * m - n}`;
  }
  const s1 = c.RACER.match(/start at “(.)” and count (\d+)/);
  const l1 = s1 ? String.fromCharCode(s1[1]!.charCodeAt(0) + Number(s1[2])) : c.RACER.match(/is “(.)”/)![1];
  const l2 = String.fromCharCode(Number(c.ENGINEER.match(/code (\d+)/)![1]));
  const ords = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  const [, ord, word] = c.DECEIVER.match(/the (\w+) letter of the word “(.+)”/)!;
  const l4 = String.fromCharCode(64 + Number(c.CAPTAIN.match(/number (\d+)/)![1]));
  return `${l1}${l2}${word![ords.indexOf(ord!)]}${l4}`;
}

test('M4: four browser contexts, every role UI active at once during one challenge window', async ({ request }) => {
  const { captain, racer, engineer, deceiver } = squadPages;
  const warp = (toElapsedMs: number) => request.post(`${SERVER_URL}/api/host/warp`, { headers: { 'x-host-key': HOST_KEY }, data: { toElapsedMs } });

  // 09:30 — Coding Round 1 is open: the Engineer answers on their phone.
  expect((await warp(9.5 * 60_000)).ok()).toBe(true);
  await expect(engineer.getByTestId('role-console')).toHaveAttribute('data-role', 'ENGINEER');
  const q1 = engineer.getByTestId('question-1');
  await expect(q1.locator('pre.code')).not.toBeEmpty();
  if (await q1.locator('input').count()) {
    await q1.locator('input').fill('0');
    await q1.getByRole('button', { name: 'Submit' }).click();
  } else await q1.locator('.btn.opt').first().click();
  await expect(engineer.getByTestId('question-1-result')).toHaveText(/Correct|attempt|No attempts/);

  // 10:45 — Four-Key Puzzle 1 + Bluff Round 1 writing: all four roles are active simultaneously.
  expect((await warp(10.75 * 60_000)).ok()).toBe(true);
  const clueOf = async (p: Page, testid: string) => (await p.getByTestId(testid).locator('div').last().innerText()).trim();
  await expect(racer.getByTestId('racer-clue')).toBeVisible();
  for (const p of [captain, engineer, deceiver]) await expect(p.getByTestId('clue-fourkey-1')).toBeVisible();
  const clues = {
    RACER: await clueOf(racer, 'racer-clue'),
    ENGINEER: await clueOf(engineer, 'clue-fourkey-1'),
    DECEIVER: await clueOf(deceiver, 'clue-fourkey-1'),
    CAPTAIN: await clueOf(captain, 'clue-fourkey-1'),
  };
  // Each phone shows a different, private clue.
  expect(new Set(Object.values(clues)).size).toBe(4);
  // Only the Captain gets the submit form.
  await expect(engineer.getByTestId('fourkey-input-fourkey-1')).toHaveCount(0);

  // Deceiver writes a bluff while the Captain combines the clues the squad read out.
  await deceiver.getByTestId('bluff-input-bluff-1').fill('A tiny cricket');
  await deceiver.getByTestId('bluff-submit-bluff-1').click();
  await captain.getByTestId('fourkey-input-fourkey-1').fill(decodeFourKey(clues));
  await captain.getByTestId('fourkey-submit-fourkey-1').click();
  await expect(captain.getByTestId('fourkey-result-fourkey-1')).toHaveText(/Correct! \+75/);
  await expect(deceiver.getByTestId('bluff-entry-bluff-1')).toContainText('A tiny cricket');
  // Squad score is shared by all role consoles (derived from server scoring events).
  for (const p of [captain, engineer, deceiver]) await expect(p.getByTestId('squad-score')).toHaveText(/^(150|157|168) pts$/);

  // Captain sets a waypoint: the Racer's HUD shows the arrow toward it.
  await captain.getByTestId('wp-hexaware').click();
  await expect(racer.getByTestId('racer-waypoint')).toContainText('Hexaware Gate');
  await racer.screenshot({ path: 'test-results/m4-racer.png' });
  await captain.screenshot({ path: 'test-results/m4-captain.png', fullPage: true });
});

test('M6: Monsoon Protocol reaches every phone and the host in the same update', async ({ request, browser }) => {
  const { captain, racer, engineer, deceiver } = squadPages;
  const host = await (await browser.newContext()).newPage();
  await host.goto('/host');
  await host.getByTestId('host-key').fill(HOST_KEY);
  await host.getByTestId('host-login').click();
  await expect(host.getByTestId('host-world')).toBeVisible();
  await expect(host.getByTestId('host-weather')).toHaveText('Dry');
  expect((await request.post(`${SERVER_URL}/api/host/warp`, { headers: { 'x-host-key': HOST_KEY }, data: { toElapsedMs: 37 * 60_000 + 2000 } })).ok()).toBe(true);
  await expect(racer.getByTestId('announcement')).toContainText('MONSOON PROTOCOL');
  for (const p of [captain, engineer, deceiver]) {
    await expect(p.getByTestId('announcement')).toContainText('MONSOON PROTOCOL');
    await expect(p.getByTestId('world-status')).toContainText('Rain');
    await expect(p.getByTestId('credits')).toContainText(/\d+/);
  }
  await expect(host.getByTestId('host-weather')).toHaveText('Rain (grip −20%)');
  await expect(host.getByTestId('host-world')).toContainText('MONSOON_PROTOCOL — rain:on');
  await racer.screenshot({ path: 'test-results/m6-racer-rain.png' });
});

test('M7: gate for every role → disclosed escort → convoy finale on every phone → podium + PDF letter', async ({ request }) => {
  const { captain, racer, engineer, deceiver } = squadPages;
  const warp = (m: number) => request.post(`${SERVER_URL}/api/host/warp`, { headers: { 'x-host-key': HOST_KEY }, data: { toElapsedMs: m * 60_000 } });
  expect((await warp(50.1)).ok()).toBe(true);
  for (const p of [captain, engineer, deceiver]) await expect(p.getByTestId('gate-card')).toBeVisible();
  await expect(captain.getByTestId('gate-code-input')).toBeVisible();
  await engineer.getByTestId('gate-debug-Line-2').click();
  await expect(engineer.getByTestId('gate-digit')).toContainText(/\d/);
  await deceiver.getByTestId('gate-badge-0').click();
  await expect(deceiver.getByTestId('gate-digit')).toContainText(/\d/);
  // Racer is still on the road: request the disclosed escort.
  await racer.getByTestId('racer-escort').click();
  await expect(racer.getByTestId('escort-banner')).toContainText('Skipped checkpoints score 0');
  await racer.screenshot({ path: 'test-results/m7-escort.png' });

  // 55:00 — every phone (all four roles) shows the same Welcome Convoy.
  expect((await warp(55.05)).ok()).toBe(true);
  for (const p of [captain, racer, engineer, deceiver]) {
    await expect(p.getByTestId('finale')).toBeVisible({ timeout: 20_000 });
    await expect(p.getByTestId('finale')).toContainText(/\d+ SQUADS?\./);
    await expect(p.getByTestId('finale')).toContainText('WELCOME TO HEXAWARE.');
  }
  // 58:00 — championship reveal + commemorative letter download.
  expect((await warp(58.05)).ok()).toBe(true);
  for (const p of [captain, racer, engineer, deceiver]) await expect(p.getByTestId('podium')).toBeVisible({ timeout: 20_000 });
  await expect(captain.getByTestId('my-result')).toContainText('#1');
  const dl = captain.waitForEvent('download');
  await captain.getByTestId('download-letter').click();
  const file = await dl;
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  await captain.screenshot({ path: 'test-results/m7-finale.png' });
});

test('registration is closed for new squads after START', async ({ browser }) => {
  const p = await newPage(browser);
  await p.goto('/');
  await expect(p.getByTestId('resume-session')).toHaveCount(0);
  await p.getByTestId('display-name').fill('Late');
  await p.getByTestId('squad-name').fill('Too Late');
  await p.getByTestId('submit').click();
  await expect(p.getByRole('alert')).toContainText(/Registration is closed/);
});
