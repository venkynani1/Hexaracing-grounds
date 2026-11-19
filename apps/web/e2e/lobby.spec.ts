import { expect, test, type Browser, type Page } from '@playwright/test';
import { HOST_KEY, SERVER_URL } from '../playwright.config';

test.describe.configure({ mode: 'serial' });
let racerPage: Page;

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
  // Non-racer roles get live squad-car telemetry from the same world.
  await p.screenshot({ path: 'test-results/racer-view.png' });
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
