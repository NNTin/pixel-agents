import { expect, test } from '../../fixtures/pixel-agents';
import {
  preToolUseBash,
  sessionEndClear,
  sessionEndResume,
  sessionStartClear,
  sessionStartResume,
} from '../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  mockClaudeInitRecord,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
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
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B1 internal clear reassignment')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .emitHook(sessionEndClear('{{sessionId}}') as Record<string, unknown>)
        .at(3_600)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-ready'), {
          session: 'replacement',
        })
        .at(3_800)
        .emitHook(
          sessionStartClear(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(4_200)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(4_800)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm run stale') as Record<string, unknown>)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('B3 internal resume reassignment within grace', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B3 internal resume reassignment')
        .defineSession('replacement', '{{sessionId}}-resume')
        .at(3_500)
        .emitHook(sessionEndResume('{{sessionId}}') as Record<string, unknown>)
        .at(3_600)
        .appendJsonl(mockClaudeInitRecord('mock-claude-resume-ready'), {
          session: 'replacement',
        })
        .at(3_800)
        .emitHook(
          sessionStartResume(
            '{{sessions.replacement.sessionId}}',
            '{{cwd}}',
            '{{sessions.replacement.transcriptPath}}',
          ) as Record<string, unknown>,
        )
        .at(4_200)
        .emitHook(
          preToolUseBash('{{sessions.replacement.sessionId}}', 'npm test') as Record<
            string,
            unknown
          >,
        )
        .at(4_800)
        .emitHook(preToolUseBash('{{sessionId}}', 'npm run stale') as Record<string, unknown>)
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(500);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');

    await panelFrame.waitForTimeout(2_500);
    await expectOverlayVisible(panelFrame, 'Running: npm test');
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });
});
