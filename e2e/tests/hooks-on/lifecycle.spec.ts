import { expect, test } from '../../fixtures/pixel-agents';
import {
  preToolUseBash,
  sendHookEvent,
  sessionEndClear,
  sessionEndResume,
  sessionStartClear,
  sessionStartResume,
  waitForHookServer,
} from '../../helpers/hooks';
import { createTranscriptStub, spawnInternalAgentAndWait } from '../../helpers/internal-agent';
import {
  expectNoOverlay,
  expectOverlayCount,
  expectOverlayVisible,
  expectSingleAgentOverlay,
  readAgentOverlayIds,
} from '../../helpers/office';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../helpers/webview';

test.describe('Hooks ON / Lifecycle', () => {
  test('B1 internal clear reassignment', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);
    const serverConfig = await waitForHookServer(tmpHome);

    const replacementSessionId = `${spawned.sessionId}-clear`;
    const replacementTranscriptPath = createTranscriptStub(
      spawned.projectDir,
      replacementSessionId,
    );

    await sendHookEvent(serverConfig, sessionEndClear(spawned.sessionId));
    await sendHookEvent(
      serverConfig,
      sessionStartClear(replacementSessionId, workspaceDir, replacementTranscriptPath),
    );
    await panelFrame.waitForTimeout(250);
    await sendHookEvent(serverConfig, preToolUseBash(replacementSessionId, 'npm test'));

    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await sendHookEvent(serverConfig, preToolUseBash(spawned.sessionId, 'npm run stale'));
    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('B3 internal resume reassignment within grace', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);
    const serverConfig = await waitForHookServer(tmpHome);

    const replacementSessionId = `${spawned.sessionId}-resume`;
    const replacementTranscriptPath = createTranscriptStub(
      spawned.projectDir,
      replacementSessionId,
    );

    await sendHookEvent(serverConfig, sessionEndResume(spawned.sessionId));
    await sendHookEvent(
      serverConfig,
      sessionStartResume(replacementSessionId, workspaceDir, replacementTranscriptPath),
    );
    await panelFrame.waitForTimeout(250);
    await sendHookEvent(serverConfig, preToolUseBash(replacementSessionId, 'npm test'));

    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await sendHookEvent(serverConfig, preToolUseBash(spawned.sessionId, 'npm run stale'));
    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');

    await panelFrame.waitForTimeout(2_500);
    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });
});
