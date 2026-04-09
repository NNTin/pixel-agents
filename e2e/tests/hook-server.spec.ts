import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { sendHookEvent, waitForHookServer } from '../helpers/hook-server';
import { launchVSCode, waitForWorkbench } from '../helpers/launch';
import {
  configureHookServerTestView,
  getPixelAgentsFrame,
  openPixelAgentsPanel,
} from '../helpers/webview';

test('hook server stages, activates, notifies, and despawns an external session', async ({}, testInfo) => {
  const session = await launchVSCode(testInfo.title);
  const { window, tmpHome, workspaceDir } = session;
  const runVideo = window.video();
  const sentEvents: string[] = [];
  const sessionId = 'manual-session-1';

  test.setTimeout(120_000);

  try {
    await waitForWorkbench(window);
    await openPixelAgentsPanel(window);

    const frame = await getPixelAgentsFrame(window);
    await configureHookServerTestView(frame);

    const serverConfig = await waitForHookServer(tmpHome);
    await testInfo.attach('hook-server-config', {
      body: JSON.stringify(serverConfig, null, 2),
      contentType: 'application/json',
    });

    const agentCard = frame.getByText('Agent #1', { exact: true });

    const stageSessionEvent = {
      session_id: sessionId,
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: workspaceDir,
    } satisfies Record<string, unknown>;
    await sendHookEvent(serverConfig, stageSessionEvent);
    sentEvents.push(JSON.stringify(stageSessionEvent));

    await frame.waitForTimeout(500);
    await expect(agentCard).toHaveCount(0);

    const confirmSessionEvent = {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'npm test',
      },
    } satisfies Record<string, unknown>;
    await sendHookEvent(serverConfig, confirmSessionEvent);
    sentEvents.push(JSON.stringify(confirmSessionEvent));

    await expect(agentCard).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText('Running: npm test', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const permissionEvent = {
      session_id: sessionId,
      hook_event_name: 'PermissionRequest',
    } satisfies Record<string, unknown>;
    await sendHookEvent(serverConfig, permissionEvent);
    sentEvents.push(JSON.stringify(permissionEvent));

    await expect(frame.getByText('Needs approval', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const idlePromptEvent = {
      session_id: sessionId,
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    } satisfies Record<string, unknown>;
    await sendHookEvent(serverConfig, idlePromptEvent);
    sentEvents.push(JSON.stringify(idlePromptEvent));

    await expect(frame.getByText('Might be waiting for input', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const endSessionEvent = {
      session_id: sessionId,
      hook_event_name: 'SessionEnd',
      reason: 'exit',
    } satisfies Record<string, unknown>;
    await sendHookEvent(serverConfig, endSessionEvent);
    sentEvents.push(JSON.stringify(endSessionEvent));

    await expect(agentCard).toHaveCount(0, { timeout: 15_000 });
  } finally {
    if (sentEvents.length > 0) {
      await testInfo.attach('hook-events', {
        body: sentEvents.join('\n'),
        contentType: 'text/plain',
      });
    }

    const serverJsonPath = path.join(tmpHome, '.pixel-agents', 'server.json');
    try {
      const serverJson = fs.readFileSync(serverJsonPath, 'utf8');
      await testInfo.attach('server-json', {
        body: serverJson,
        contentType: 'application/json',
      });
    } catch {
      // server.json may be gone if the app already shut down
    }

    const screenshotPath = path.join(
      __dirname,
      '../../test-results/e2e',
      `hook-server-final-${Date.now()}.png`,
    );
    try {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await window.screenshot({ path: screenshotPath });
      await testInfo.attach('final-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } catch {
      // screenshot failure is non-fatal
    }

    await session.cleanup();

    if (runVideo) {
      try {
        const videoPath = testInfo.outputPath('run-video.webm');
        await runVideo.saveAs(videoPath);
        await testInfo.attach('run-video', {
          path: videoPath,
          contentType: 'video/webm',
        });
      } catch {
        // video attachment failure is non-fatal
      }
    }
  }
});
