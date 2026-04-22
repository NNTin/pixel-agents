import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, Page } from '@playwright/test';
import { chromium, expect } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer } from 'vite';
import { test } from 'vitest';

interface ServerConfig {
  port: number;
  token: string;
}

const webviewRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webviewRoot, '..');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttpOk(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`GET ${url} returned ${response.status.toString()}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

async function waitForServerConfig(filePath: string): Promise<ServerConfig> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ServerConfig;
      }
    } catch {
      // File may still be mid-write; retry.
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

async function startDevServer(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: path.resolve(webviewRoot, 'vite.config.ts'),
    server: { port: await getFreePort(), strictPort: true },
    logLevel: 'silent',
  });
  await server.listen();
  return server;
}

function serverUrl(server: ViteDevServer): string {
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5173;
  return `http://127.0.0.1:${port}`;
}

function createVsCodeShimRoot(): string {
  const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-vscode-shim-'));
  const vscodeDir = path.join(shimRoot, 'vscode');

  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(vscodeDir, 'index.js'),
    [
      'module.exports = {',
      '  workspace: { workspaceFolders: [] },',
      '  window: {',
      '    terminals: [],',
      "    createTerminal() { throw new Error('createTerminal is unavailable in standalone tests'); },",
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  return shimRoot;
}

function spawnStandaloneHost(args: {
  homeDir: string;
  hostPort: number;
  nodePathRoot: string;
  workspaceDir: string;
}): ChildProcessWithoutNullStreams {
  const tsxCli = path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const nodePathParts = [args.nodePathRoot, process.env.NODE_PATH].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return spawn(
    process.execPath,
    [
      tsxCli,
      path.resolve(repoRoot, 'standalone', 'host.ts'),
      '--port',
      args.hostPort.toString(),
      '--workspace-dir',
      args.workspaceDir,
      '--assets-root',
      path.resolve(repoRoot, 'webview-ui', 'public'),
      '--repo-root',
      repoRoot,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: args.homeDir,
        NODE_PATH: nodePathParts.join(path.delimiter),
        USERPROFILE: args.homeDir,
      },
      stdio: 'pipe',
    },
  );
}

async function openLiveStandalonePage(
  page: Page,
  browserBaseUrl: string,
  hostUrl: string,
): Promise<void> {
  await page.goto(`${browserBaseUrl}/?host=${encodeURIComponent(hostUrl)}`);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
}

async function enableAlwaysShowLabels(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Always Show Labels/ }).click();
  await page.mouse.click(5, 5);
}

async function postHook(
  serverConfig: ServerConfig,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${serverConfig.port}/api/hooks/claude`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serverConfig.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200, `Hook POST returned ${response.status.toString()}`);
}

test('standalone host propagates hook-driven agent lifecycle into the browser UI', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-standalone-home-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-standalone-workspace-'));
  const vscodeShimRoot = createVsCodeShimRoot();
  const hostPort = await getFreePort();
  const hostUrl = `http://127.0.0.1:${hostPort}`;
  const hostProcess = spawnStandaloneHost({
    homeDir: tempHome,
    hostPort,
    nodePathRoot: vscodeShimRoot,
    workspaceDir,
  });

  let devServer: ViteDevServer | null = null;
  let browser: Browser | null = null;

  hostProcess.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  hostProcess.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  try {
    await waitForHttpOk(`${hostUrl}/api/health`);
    const hookServerConfig = await waitForServerConfig(
      path.join(tempHome, '.pixel-agents', 'server.json'),
    );

    devServer = await startDevServer();
    browser = await chromium.launch();
    const page = await browser.newPage();

    await openLiveStandalonePage(page, serverUrl(devServer), hostUrl);
    await enableAlwaysShowLabels(page);

    const sessionId = 'standalone-hooks-test-session';

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: workspaceDir,
    });

    await expect(page.locator('[data-testid="agent-overlay"]')).toHaveCount(0);

    const filePath = path.join(workspaceDir, 'demo.ts');
    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    await expect(page.locator('[data-testid="agent-overlay"]')).toHaveCount(1);
    await expect(page.getByText('Reading demo.ts')).toBeVisible();

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PermissionRequest',
    });
    await expect(page.getByText('Needs approval')).toBeVisible();

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'Stop',
    });
    await expect(page.getByText('Might be waiting for input')).toBeVisible();

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'SessionEnd',
      reason: 'exit',
    });
    await expect(page.locator('[data-testid="agent-overlay"]')).toHaveCount(0);
  } finally {
    if (browser) {
      await browser.close();
    }
    if (devServer) {
      await devServer.close();
    }
    hostProcess.kill('SIGTERM');
    await delay(250);
    fs.rmSync(vscodeShimRoot, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
