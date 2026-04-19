import { expect, test } from '../../fixtures/pixel-agents';
import {
  INLINE_TEAMMATE_ALIAS,
  INLINE_TEAMMATE_ROLE,
  uniqueTeamName,
  withInlineTeammateSession,
} from '../../helpers/lifecycle';
import {
  spawnInternalAgentAndWait,
  spawnInternalAgentAndWaitForInvocation,
} from '../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  mockClaudeInitRecord,
} from '../../helpers/mock-claude';
import {
  expectNoOverlay,
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisible,
  expectOverlayVisibleWithTexts,
  expectSingleAgentOverlay,
  readAgentOverlayIds,
} from '../../helpers/office';
import {
  buildAssistantToolUseRecord,
  buildAssistantToolUseBatchRecord,
  buildClearCommandRecord,
  buildTeamConfig,
  buildTeamMetadataRecord,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
  seedTeamConfig,
} from '../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../helpers/webview';

const PARALLEL_PARENT_TOOL_ID = 'toolu-b5-parent';

test.describe('Hooks OFF / Lifecycle', () => {
  test('B1 internal clear reassignment', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B1 internal clear reassignment hooks off')
        .defineSession('replacement', '{{sessionId}}-clear')
        .at(3_500)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-ready'), {
          session: 'replacement',
        })
        .at(3_550)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(4_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b1-fresh', 'Bash', {
            command: 'npm test',
          }),
          { session: 'replacement' },
        )
        .at(5_100)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b1-stale', 'Bash', {
            command: 'npm run stale',
          }),
        )
        .holdOpenFor(8_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run stale');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('B3 internal resume reassignment within grace', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B3 internal resume reassignment hooks off')
        .withoutAutoInit()
        .defineSession('replacement', '{{sessionId}}-resume')
        .at(11_000)
        .appendJsonl(mockClaudeInitRecord('mock-claude-resume-ready'), {
          session: 'replacement',
        })
        .at(11_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b3-fresh', 'Bash', {
            command: 'npm test',
          }),
          { session: 'replacement' },
        )
        .holdOpenFor(16_000)
        .build(),
    );

    await spawnInternalAgentAndWaitForInvocation(frame, tmpHome, workspaceDir, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm test', 16_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });

  test('B5 three parallel Task subagents in one turn', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B5 three parallel Task subagents in one turn hooks off')
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseBatchRecord([
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-1`,
              toolName: 'Task',
              input: { description: 'Parallel task 1' },
            },
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-2`,
              toolName: 'Task',
              input: { description: 'Parallel task 2' },
            },
            {
              toolId: `${PARALLEL_PARENT_TOOL_ID}-3`,
              toolName: 'Task',
              input: { description: 'Parallel task 3' },
            },
          ]),
        )
        .at(9_000)
        .appendJsonl(
          buildUserToolResultBatchRecord([
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-1` },
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-2` },
            { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-3` },
          ]),
        )
        .at(10_200)
        .appendJsonl(buildTurnDurationRecord())
        .holdOpenFor(13_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisible(panelFrame, 'Subtask: Parallel task 3');
    await expectOverlayVisible(panelFrame, 'Parallel task 1');
    await expectOverlayVisible(panelFrame, 'Parallel task 2');
    await expectOverlayVisible(panelFrame, 'Parallel task 3');
    await expectOverlayCount(panelFrame, 4, 10_000);
    expect(await readAgentOverlayIds(panelFrame)).toHaveLength(4);

    await expectOverlayCount(panelFrame, 1, 16_000);
  });

  test('B6 inline teammate removed from config', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;
    const teamName = uniqueTeamName('b6-inline-hooks-off');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      withInlineTeammateSession(claudeScenario('B6 inline teammate removed from config hooks off'))
        .at(500)
        .appendJsonl(buildTeamMetadataRecord(teamName))
        .at(1_500)
        .appendJsonl(buildTeamMetadataRecord(teamName, INLINE_TEAMMATE_ROLE), {
          session: INLINE_TEAMMATE_ALIAS,
        })
        .at(2_500)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b6-teammate-search', 'WebSearch', {
            query: 'pixel agents lifecycle regressions',
          }),
          { session: INLINE_TEAMMATE_ALIAS },
        )
        .at(8_000)
        .writeJson(configPath, buildTeamConfig(['lead']))
        .holdOpenFor(14_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    await expectOverlayVisibleWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 10_000);
    await expectOverlayVisible(panelFrame, 'Searching the web');
    await expectOverlayCount(panelFrame, 2, 10_000);

    await expectOverlayCount(panelFrame, 1, 12_000);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);

    await panelFrame.waitForTimeout(8_000);
    await expectOverlayCount(panelFrame, 1);
    await expectNoOverlayWithTexts(panelFrame, [INLINE_TEAMMATE_ROLE], 2_000);
  });

  test('B11 rapid clear then new tool in under 500 ms', async ({ pixelAgents }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('B11 rapid clear then new tool in under 500 ms hooks off')
        .defineSession('replacement', '{{sessionId}}-clear-fast')
        .at(3_000)
        .appendJsonl(mockClaudeInitRecord('mock-claude-clear-fast-ready'), {
          session: 'replacement',
        })
        .at(3_050)
        .appendJsonl(buildClearCommandRecord(), {
          session: 'replacement',
        })
        .at(3_200)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b11-fresh', 'Bash', {
            command: 'npm run fresh',
          }),
          { session: 'replacement' },
        )
        .at(3_350)
        .appendJsonl(
          buildAssistantToolUseRecord('toolu-b11-ghost', 'Bash', {
            command: 'npm run ghost',
          }),
        )
        .holdOpenFor(7_000)
        .build(),
    );

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const originalAgentId = await expectSingleAgentOverlay(panelFrame);

    await expectOverlayVisible(panelFrame, 'Running: npm run fresh', 12_000);
    await expectOverlayCount(panelFrame, 1);
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);

    await panelFrame.waitForTimeout(1_000);
    await expectNoOverlay(panelFrame, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(panelFrame)).toEqual([originalAgentId]);
  });
});
