import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = 2599;
const WEB_PORT = 5199;
export const HOST_KEY = 'e2e-host-key-0001';
export const SERVER_URL = `http://localhost:${SERVER_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : 'line',
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'off' },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: [
    {
      command: 'npm run start -w @redline/server',
      cwd: '../..',
      port: SERVER_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        HOST_ADMIN_KEY: HOST_KEY,
        SESSION_SECRET: 'e2e-session-secret-e2e-session-secret',
        PUBLIC_WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
        EVENT_NAME: 'e2e',
        DATABASE_URL: '',
        // Short countdown and immediate release so the smoke test can drive within seconds.
        COUNTDOWN_MS: '2000',
        RELEASE_AT_MS: '0',
        // Rehearsal-only clock warp so the test can reach the 10:00 challenges in seconds.
        ALLOW_TIME_WARP: 'true',
      },
    },
    {
      command: 'npx vite',
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WEB_PORT: String(WEB_PORT), REDLINE_DEV_SERVER: `http://localhost:${SERVER_PORT}` },
    },
  ],
});
