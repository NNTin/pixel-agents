import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(repoRoot, 'allure-results', 'e2e');
const reportDir = path.join(repoRoot, 'allure-report', 'e2e');

function hasFiles(dir) {
  if (!existsSync(dir)) return false;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFiles(path.join(dir, entry.name))) return true;
  }

  return false;
}

function writeGithubMetadata() {
  if (!hasFiles(resultsDir)) return;

  const serverUrl = process.env['GITHUB_SERVER_URL'];
  const repository = process.env['GITHUB_REPOSITORY'];
  const runId = process.env['GITHUB_RUN_ID'];
  const runNumber = process.env['GITHUB_RUN_NUMBER'];
  const workflow = process.env['GITHUB_WORKFLOW'];
  const refName = process.env['GITHUB_REF_NAME'];

  if (serverUrl && repository && runId) {
    writeFileSync(
      path.join(resultsDir, 'executor.json'),
      JSON.stringify(
        {
          name: 'GitHub Actions',
          type: 'github',
          buildName: workflow && runNumber ? `${workflow} #${runNumber}` : workflow,
          buildOrder: runNumber ? Number.parseInt(runNumber, 10) : undefined,
          buildUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
          reportName: 'Pixel Agents E2E',
        },
        null,
        2,
      ),
    );
  }

  const environmentLines = [
    `deployment=vercel`,
    `suite=playwright-electron`,
    `branch=${refName ?? 'local'}`,
  ];
  writeFileSync(
    path.join(resultsDir, 'environment.properties'),
    `${environmentLines.join('\n')}\n`,
  );
}

function writePlaceholderReport() {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pixel Agents E2E Report Unavailable</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f4f6f8;
        color: #17202a;
      }
      main {
        max-width: 36rem;
        padding: 2rem;
        border: 1px solid #d0d7de;
        background: #ffffff;
        box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin-top: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>E2E report unavailable</h1>
      <p>No Allure results were produced for this run, so there is no hosted report to display.</p>
      <p>Check the workflow logs for Playwright setup failures or skipped Linux E2E execution.</p>
    </main>
  </body>
</html>
`,
  );
}

if (!hasFiles(resultsDir)) {
  writePlaceholderReport();
  process.exit(0);
}

writeGithubMetadata();

rmSync(reportDir, { recursive: true, force: true });
mkdirSync(path.dirname(reportDir), { recursive: true });

const allureBinary = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'allure.cmd' : 'allure',
);

const result = spawnSync(allureBinary, ['generate', resultsDir, '--clean', '-o', reportDir], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
