import { type ClaudeMockScenarioBuilder } from './mock-claude';

export const INLINE_TEAMMATE_ROLE = 'web-researcher';
export const INLINE_TEAMMATE_ALIAS = 'teammate';
export const INLINE_TEAMMATE_SLUG = `agent-${INLINE_TEAMMATE_ROLE}`;

export function uniqueTeamName(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

export function withInlineTeammateSession(
  builder: ClaudeMockScenarioBuilder,
): ClaudeMockScenarioBuilder {
  return builder.defineSession(INLINE_TEAMMATE_ALIAS, INLINE_TEAMMATE_SLUG, {
    transcriptPathTemplate: `{{projectDir}}/{{sessionId}}/subagents/${INLINE_TEAMMATE_SLUG}.jsonl`,
    sidecarPathTemplate: `{{projectDir}}/{{sessionId}}/subagents/${INLINE_TEAMMATE_SLUG}.meta.json`,
    sidecarJson: {
      agentType: INLINE_TEAMMATE_ROLE,
    },
  });
}
