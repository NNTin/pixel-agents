import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ATTACH_VIDEOS_ON_SUCCESS_FLAG = '--attach-videos-on-success';
const ATTACH_VIDEOS_ON_SUCCESS_ENV = 'PIXEL_AGENTS_E2E_ATTACH_VIDEOS_ON_SUCCESS';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = path.join(repoRoot, 'node_modules', 'playwright', 'cli.js');

const forwardedArgs = [];
let attachVideosOnSuccess = false;

for (const arg of process.argv.slice(2)) {
  if (arg === ATTACH_VIDEOS_ON_SUCCESS_FLAG) {
    attachVideosOnSuccess = true;
    continue;
  }

  forwardedArgs.push(arg);
}

const result = spawnSync(
  process.execPath,
  [playwrightCli, 'test', '--config', 'e2e/playwright.config.ts', ...forwardedArgs],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(attachVideosOnSuccess ? { [ATTACH_VIDEOS_ON_SUCCESS_ENV]: '1' } : {}),
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
