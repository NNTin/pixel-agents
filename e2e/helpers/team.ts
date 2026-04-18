import fs from 'fs';
import path from 'path';

function claudeProjectDirName(workspaceDir: string): string {
  return workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function getClaudeProjectDir(tmpHome: string, workspaceDir: string): string {
  return path.join(tmpHome, '.claude', 'projects', claudeProjectDirName(workspaceDir));
}

export function createClaudeTranscript(
  tmpHome: string,
  workspaceDir: string,
  sessionId: string,
): { projectDir: string; transcriptPath: string } {
  const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
  fs.mkdirSync(projectDir, { recursive: true });

  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, '');
  }

  return { projectDir, transcriptPath };
}

export function appendJsonlRecord(jsonlPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
}

export function appendTeamMetadata(jsonlPath: string, teamName: string, agentName?: string): void {
  const record: Record<string, unknown> = {
    type: 'system',
    teamName,
  };
  if (agentName) {
    record['agentName'] = agentName;
  }
  appendJsonlRecord(jsonlPath, record);
}

export function appendAssistantToolUse(
  jsonlPath: string,
  toolId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): void {
  appendJsonlRecord(jsonlPath, {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input,
        },
      ],
    },
  });
}

export function seedTeamConfig(tmpHome: string, teamName: string, members: string[]): string {
  const teamDir = path.join(tmpHome, '.claude', 'teams', teamName);
  fs.mkdirSync(teamDir, { recursive: true });

  const configPath = path.join(teamDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        members: members.map((name) => ({ name })),
      },
      null,
      2,
    ),
  );

  return configPath;
}

export function createTeammateTranscript(
  projectDir: string,
  leadSessionId: string,
  teammateSlug: string,
  teamName: string,
  agentName: string,
): string {
  const subagentsDir = path.join(projectDir, leadSessionId, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const transcriptPath = path.join(subagentsDir, `${teammateSlug}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  appendTeamMetadata(transcriptPath, teamName, agentName);

  fs.writeFileSync(
    transcriptPath.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType: agentName }, null, 2),
  );

  return transcriptPath;
}
