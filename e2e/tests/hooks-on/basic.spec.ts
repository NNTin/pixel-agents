import path from 'path';

import { expect, test } from '../../fixtures/pixel-agents';
import {
  idlePrompt,
  permissionRequest,
  preToolUseBash,
  sendHookEvent,
  sessionEndExit,
  sessionStartStartup,
  waitForHookServer,
} from '../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../helpers/internal-agent';
import { expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../helpers/webview';

test.describe('Hooks ON / Basic', () => {
  test('A1 internal basic spawn smoke', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    expect(spawned.invocationLog).toContain(`session-id=${spawned.sessionId}`);
    expect(path.basename(spawned.jsonlFile)).toBe(`${spawned.sessionId}.jsonl`);

    const terminalTab = window.getByText(/Claude Code #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 1);
  });

  test('A7 external hook session smoke', async ({ pixelAgents }) => {
    const { frame, tmpHome, workspaceDir } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const serverConfig = await waitForHookServer(tmpHome);
    const sessionId = 'a7-external-session';

    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir));
    await frame.waitForTimeout(500);
    await expectOverlayCount(frame, 0);

    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectOverlayVisible(frame, 'Needs approval');

    await sendHookEvent(serverConfig, idlePrompt(sessionId));
    await expectOverlayVisible(frame, 'Might be waiting for input');

    await sendHookEvent(serverConfig, sessionEndExit(sessionId));
    await expectOverlayCount(frame, 0);
  });
});
