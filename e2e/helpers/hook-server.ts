import fs from 'fs';
import path from 'path';

export interface HookServerConfig {
  port: number;
  pid: number;
  token: string;
  startedAt: number;
}

export interface HookEventPayload {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

function getServerJsonPath(tmpHome: string): string {
  return path.join(tmpHome, '.pixel-agents', 'server.json');
}

function isHookServerConfig(value: unknown): value is HookServerConfig {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.port === 'number' &&
    typeof candidate.pid === 'number' &&
    typeof candidate.token === 'string' &&
    typeof candidate.startedAt === 'number'
  );
}

function readHookServerConfig(tmpHome: string): HookServerConfig | null {
  try {
    const raw = fs.readFileSync(getServerJsonPath(tmpHome), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isHookServerConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function probeHookServer(config: HookServerConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHookServer(
  tmpHome: string,
  timeoutMs = 20_000,
): Promise<HookServerConfig> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const config = readHookServerConfig(tmpHome);
    if (config && (await probeHookServer(config))) {
      return config;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for hook server config at ${getServerJsonPath(tmpHome)}`);
}

export async function sendHookEvent(
  config: HookServerConfig,
  event: HookEventPayload,
  provider = 'claude',
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${config.port}/api/hooks/${provider}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Hook event ${event.hook_event_name} failed with ${response.status}: ${body || '<empty>'}`,
    );
  }
}
