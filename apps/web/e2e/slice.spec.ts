import { expect, test } from '@playwright/test';

// The visual vertical slice is a real-time 3D scene (not a video): it must load the licensed assets, bake its
// lighting, render frames, respond to touch input, toggle weather, and its acceptance mode must produce a gate report.
test('slice: loads, renders, touch drives the car, weather toggles, acceptance report is produced', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/slice?q=low&accept=0.25');
  await expect(page.getByTestId('slice-loading')).toHaveClass(/done/, { timeout: 180_000 });
  await expect.poll(async () => Number(await page.getByTestId('fps').getAttribute('data-fps')), { timeout: 30_000 }).toBeGreaterThan(0);
  // touch the GAS pedal: the car speeds up (shared physics on the client)
  const gas = page.getByTestId('btn-throttle');
  const b = (await gas.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect.poll(async () => Number(await page.getByTestId('hud-speed').getAttribute('data-speed')), { timeout: 30_000 }).toBeGreaterThan(10);
  await page.mouse.up();
  await page.getByTestId('btn-rain').click();
  await expect(page.getByTestId('announcement')).toContainText('MONSOON');
  // acceptance mode (15 s here) → gate report with all checks
  await expect(page.getByTestId('accept-result')).toBeVisible({ timeout: 90_000 });
  const report = await page.evaluate(() => (window as unknown as { __accept: { report: Record<string, number>; gate: { checks: unknown[] } } }).__accept);
  expect(report.gate.checks.length).toBe(8); // incl. 'Uninterrupted run'
  expect(report.report.frames).toBeGreaterThan(10);
  expect(report.report.textureMemMB).toBeLessThan(64);
  expect(errors).toEqual([]);
});

test('benchmark: launcher (offline) → car+road, low, 3-min autopilot loads the real renderer with live FPS/frame time', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/benchmark');
  await expect(page.getByTestId('benchmark-launcher')).toContainText('Offline test mode');
  await page.getByTestId('bench-scene-A').check();
  await page.getByTestId('bench-q-low').check();
  await page.getByTestId('bench-mode-auto3').check();
  await expect(page.getByTestId('bench-start')).toHaveAttribute('href', '/benchmark?run=1&bench=A&rain=0&q=low&accept=3&auto=1');
  await page.getByTestId('bench-start').click();
  await expect(page.getByTestId('slice-loading')).toHaveClass(/done/, { timeout: 180_000 });
  await expect(page.locator('.rh-tag')).toContainText('Offline benchmark · car + road');
  await expect(page.getByTestId('frametime')).toContainText('ms');
  await expect.poll(async () => Number(await page.getByTestId('fps').getAttribute('data-fps')), { timeout: 20_000 }).toBeGreaterThan(0);
});
