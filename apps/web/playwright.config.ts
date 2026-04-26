import { defineConfig, devices } from '@playwright/test';

/**
 * V1.5 (Sprint O) — Configuration Playwright pour les tests E2E.
 *
 * Lance le dev server Angular automatiquement (4200) et exerce les user-flows
 * critiques. La config attend que l'API tourne en parallele (port 3000) —
 * voir docs/14-tests-runbook.md pour la procedure complete.
 *
 * Run :
 *   pnpm --filter @vizyo/tracky-web exec playwright test
 *   pnpm --filter @vizyo/tracky-web exec playwright test --ui  (mode debug)
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // les flows touchent la DB partagee
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_SKIP_DEV_SERVER
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:4200',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
