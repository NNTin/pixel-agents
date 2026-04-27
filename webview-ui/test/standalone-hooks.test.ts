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

import type { ServerMessage } from '../../core/src/messages.js';

interface ServerConfig {
  port: number;
  token: string;
}

interface ProducerHarness {
  socket: WebSocket | null;
  received: Array<Record<string, unknown>>;
  bootstrapMessages: Array<Record<string, unknown>>;
}

type ProducerHarnessWindow = Window & {
  __producerHarness?: ProducerHarness;
};

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

async function installMessageRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type RecorderGlobal = typeof globalThis & {
      __pixelAgentsMessages?: unknown[];
      WebSocket: typeof WebSocket;
    };

    const browserGlobal = globalThis as RecorderGlobal;
    const recordedMessages: unknown[] = [];
    const OriginalWebSocket = browserGlobal.WebSocket;

    const RecordingWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') {
            return;
          }
          try {
            recordedMessages.push(JSON.parse(event.data));
          } catch {
            // Ignore non-JSON frames.
          }
        });
        return socket;
      },
    });

    browserGlobal.WebSocket = RecordingWebSocket as typeof WebSocket;
    browserGlobal.__pixelAgentsMessages = recordedMessages;
  });
}

async function drainRecordedMessages(page: Page): Promise<ServerMessage[]> {
  return await page.evaluate(() => {
    const store = (globalThis as typeof globalThis & { __pixelAgentsMessages?: unknown[] })
      .__pixelAgentsMessages;
    if (!Array.isArray(store)) {
      return [];
    }
    const drained = store.slice();
    store.length = 0;
    return drained as ServerMessage[];
  });
}

function toWebSocketUrl(baseUrl: string, pathname: string): string {
  const url = new URL(pathname, baseUrl);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  return url.toString();
}

async function installProducerHarness(page: Page): Promise<void> {
  await page.goto('about:blank');
  await page.evaluate(() => {
    const producerWindow = window as ProducerHarnessWindow;
    producerWindow.__producerHarness = {
      socket: null,
      received: [],
      bootstrapMessages: [],
    };
  });
}

async function setProducerBootstrapMessages(
  page: Page,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await page.evaluate((nextMessages) => {
    const producerWindow = window as ProducerHarnessWindow;
    if (!producerWindow.__producerHarness) {
      throw new Error('Producer harness is not installed');
    }
    producerWindow.__producerHarness.bootstrapMessages = nextMessages;
  }, messages);
}

async function connectProducer(page: Page, hostUrl: string): Promise<void> {
  const producerUrl = toWebSocketUrl(hostUrl, '/ws/producer');
  await page.evaluate(async (url) => {
    const producerWindow = window as ProducerHarnessWindow;
    const harness = producerWindow.__producerHarness;
    if (!harness) {
      throw new Error('Producer harness is not installed');
    }

    if (harness.socket) {
      harness.socket.close();
      harness.socket = null;
    }
    harness.received = [];

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timeout = window.setTimeout(() => {
        reject(new Error(`Timed out connecting producer to ${url}`));
      }, 10_000);

      socket.addEventListener('open', () => {
        window.clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener('error', () => {
        window.clearTimeout(timeout);
        reject(new Error(`Producer socket failed for ${url}`));
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          return;
        }
        try {
          const parsed = JSON.parse(event.data) as Record<string, unknown>;
          harness.received.push(parsed);
          if (parsed.type === 'producerBootstrapRequest') {
            for (const message of harness.bootstrapMessages) {
              socket.send(JSON.stringify(message));
            }
          }
        } catch {
          // Ignore non-JSON frames in the producer harness.
        }
      });
      harness.socket = socket;
    });
  }, producerUrl);
}

async function disconnectProducer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const producerWindow = window as ProducerHarnessWindow;
    producerWindow.__producerHarness?.socket?.close();
    if (producerWindow.__producerHarness) {
      producerWindow.__producerHarness.socket = null;
    }
  });
}

async function sendProducerMessage(page: Page, message: Record<string, unknown>): Promise<void> {
  await page.evaluate((nextMessage) => {
    const producerWindow = window as ProducerHarnessWindow;
    const socket = producerWindow.__producerHarness?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Producer socket is not open');
    }
    socket.send(JSON.stringify(nextMessage));
  }, message);
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

test('standalone host propagates hook-driven lifecycle into the browser UI', async () => {
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

    await installMessageRecorder(page);
    await openLiveStandalonePage(page, serverUrl(devServer), hostUrl);
    await enableAlwaysShowLabels(page);
    await drainRecordedMessages(page);

    const sessionId = 'standalone-hooks-test-session';
    const agentOverlay = page.locator('[data-testid="agent-overlay"]');

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: workspaceDir,
    });

    await expect(agentOverlay).toHaveCount(0);

    const filePath = path.join(workspaceDir, 'demo.ts');
    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    await expect(agentOverlay).toHaveCount(1);
    await expect(page.getByText('Reading demo.ts')).toBeVisible();
    const preToolMessages = await drainRecordedMessages(page);
    const toolStart = preToolMessages.find(
      (message): message is Extract<ServerMessage, { type: 'agentToolStart' }> =>
        message.type === 'agentToolStart',
    );
    expect(preToolMessages.some((message) => message.type === 'agentCreated')).toBe(true);
    expect(toolStart).toBeTruthy();
    expect(
      preToolMessages.some(
        (message) => message.type === 'agentStatus' && message.status === 'active',
      ),
    ).toBe(true);

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PermissionRequest',
    });
    await expect(page.getByText('Needs approval')).toBeVisible();
    const permissionMessages = await drainRecordedMessages(page);
    expect(permissionMessages.some((message) => message.type === 'agentToolPermission')).toBe(true);

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
    });
    const postToolMessages = await drainRecordedMessages(page);
    expect(
      postToolMessages.some(
        (message) =>
          message.type === 'agentToolDone' &&
          message.toolId === toolStart?.toolId &&
          message.id === toolStart?.id,
      ),
    ).toBe(true);
    await expect(page.getByText('Needs approval')).toBeVisible();

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
    await expect(page.getByText('Might be waiting for input')).toBeVisible();
    const notificationMessages = await drainRecordedMessages(page);
    expect(notificationMessages.some((message) => message.type === 'agentToolsClear')).toBe(true);
    expect(
      notificationMessages.some(
        (message) => message.type === 'agentStatus' && message.status === 'waiting',
      ),
    ).toBe(true);

    await postHook(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'SessionEnd',
      reason: 'exit',
    });
    await expect(agentOverlay).toHaveCount(0);
    const sessionEndMessages = await drainRecordedMessages(page);
    expect(sessionEndMessages.some((message) => message.type === 'agentClosed')).toBe(true);
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

test('standalone host replays producer-backed agents to a later viewer', async () => {
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

  try {
    await waitForHttpOk(`${hostUrl}/api/health`);

    devServer = await startDevServer();
    browser = await chromium.launch();
    const producerPage = await browser.newPage();
    await installProducerHarness(producerPage);
    await setProducerBootstrapMessages(producerPage, []);
    await connectProducer(producerPage, hostUrl);

    await sendProducerMessage(producerPage, {
      type: 'agentCreated',
      id: 41,
      folderName: 'overlay-workspace',
    });
    await sendProducerMessage(producerPage, {
      type: 'agentToolStart',
      id: 41,
      toolId: 'overlay-tool-1',
      status: 'Reading demo.ts',
      toolName: 'Read',
    });
    await sendProducerMessage(producerPage, {
      type: 'agentStatus',
      id: 41,
      status: 'waiting',
    });

    const page = await browser.newPage();
    await installMessageRecorder(page);
    await openLiveStandalonePage(page, serverUrl(devServer), hostUrl);
    await enableAlwaysShowLabels(page);

    await expect(page.locator('[data-testid="agent-overlay"]')).toHaveCount(1);
    await expect(page.getByText('Reading demo.ts')).toBeVisible();
    const replayedMessages = await drainRecordedMessages(page);
    expect(
      replayedMessages.some(
        (message) =>
          message.type === 'agentStatus' && 'status' in message && message.status === 'waiting',
      ),
    ).toBe(true);
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

test('standalone host restores persisted overlay state and reconciles it on producer reconnect', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-standalone-home-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-standalone-workspace-'));
  const vscodeShimRoot = createVsCodeShimRoot();
  const hostPort = await getFreePort();
  const hostUrl = `http://127.0.0.1:${hostPort}`;

  let hostProcess = spawnStandaloneHost({
    homeDir: tempHome,
    hostPort,
    nodePathRoot: vscodeShimRoot,
    workspaceDir,
  });
  let devServer: ViteDevServer | null = null;
  let browser: Browser | null = null;

  try {
    await waitForHttpOk(`${hostUrl}/api/health`);
    devServer = await startDevServer();
    browser = await chromium.launch();

    const producerPage = await browser.newPage();
    await installProducerHarness(producerPage);
    await setProducerBootstrapMessages(producerPage, []);
    await connectProducer(producerPage, hostUrl);
    await sendProducerMessage(producerPage, {
      type: 'agentCreated',
      id: 77,
      folderName: 'persisted-overlay',
    });
    await sendProducerMessage(producerPage, {
      type: 'agentToolStart',
      id: 77,
      toolId: 'persisted-tool-1',
      status: 'Searching code',
      toolName: 'Grep',
    });

    await disconnectProducer(producerPage);
    hostProcess.kill('SIGTERM');
    await delay(500);

    hostProcess = spawnStandaloneHost({
      homeDir: tempHome,
      hostPort,
      nodePathRoot: vscodeShimRoot,
      workspaceDir,
    });
    await waitForHttpOk(`${hostUrl}/api/health`);

    const page = await browser.newPage();
    await installMessageRecorder(page);
    await openLiveStandalonePage(page, serverUrl(devServer), hostUrl);
    await enableAlwaysShowLabels(page);

    await expect(page.locator('[data-testid="agent-overlay"]')).toHaveCount(1);
    await expect(page.getByText('Searching code')).toBeVisible();

    await setProducerBootstrapMessages(producerPage, [
      {
        type: 'existingAgents',
        agents: [],
        agentMeta: {},
        folderNames: {},
        externalAgents: {},
      },
    ]);
    await connectProducer(producerPage, hostUrl);

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
