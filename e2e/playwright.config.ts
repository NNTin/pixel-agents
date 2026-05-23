import { defineConfig } from '@playwright/test';
import path from 'path';

import { namespaceE2EPath } from './run-config';

const artifactsDir = namespaceE2EPath(path.join(__dirname, '../test-results/e2e'));
const htmlReportDir = namespaceE2EPath(path.join(__dirname, '../playwright-report/e2e'));

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  timeout: 120_000,
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  reporter: [
    ['list'],
    [
      'html',
      {
        // Must be outside outputDir to avoid Playwright clearing artifacts
        outputFolder: htmlReportDir,
        open: 'never',
      },
    ],
  ],
  outputDir: artifactsDir,
  // NOTE: These settings are no-ops for Electron tests launched via electron.launch().
  // Playwright's built-in artifact handling only applies to browser contexts.
  // Video is configured in launch.ts (recordVideo option) and screenshots are
  // handled manually in the test's afterEach/finally blocks.
  use: {},
  // Default to one worker locally; CI can override this with --workers.
  workers: 1,
});
