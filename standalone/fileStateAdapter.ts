import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../core/src/adapter.js';
import type { PersistedAgent } from '../core/src/schemas.js';

interface WorkspaceStateFile {
  workspaceDir: string;
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
}

type SettingsStateFile = Record<string, unknown>;

const DEFAULT_WORKSPACE_STATE: Omit<WorkspaceStateFile, 'workspaceDir'> = {
  agents: [],
  seats: {},
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    console.error(`[Pixel Agents] Failed to read ${filePath}:`, error);
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.error(`[Pixel Agents] Failed to write ${filePath}:`, error);
  }
}

export class FileStateAdapter implements StateAdapter {
  private readonly stateDir: string;
  private readonly workspaceStatePath: string;
  private readonly settingsPath: string;

  constructor(private readonly workspaceDir: string) {
    this.stateDir = path.join(os.homedir(), '.pixel-agents', 'standalone');
    const workspaceKey = crypto
      .createHash('sha256')
      .update(path.resolve(workspaceDir))
      .digest('hex')
      .slice(0, 16);
    this.workspaceStatePath = path.join(this.stateDir, 'workspaces', `${workspaceKey}.json`);
    this.settingsPath = path.join(this.stateDir, 'settings.json');
  }

  loadAgents(): PersistedAgent[] {
    return this.readWorkspaceState().agents;
  }

  saveAgents(agents: PersistedAgent[]): void {
    const state = this.readWorkspaceState();
    state.agents = agents;
    this.writeWorkspaceState(state);
  }

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }> {
    return this.readWorkspaceState().seats;
  }

  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void {
    const state = this.readWorkspaceState();
    state.seats = seats;
    this.writeWorkspaceState(state);
  }

  getSetting<T>(key: string, defaultValue: T): T {
    const settings = readJsonFile<SettingsStateFile>(this.settingsPath, {});
    return key in settings ? (settings[key] as T) : defaultValue;
  }

  setSetting<T>(key: string, value: T): void {
    const settings = readJsonFile<SettingsStateFile>(this.settingsPath, {});
    settings[key] = value;
    writeJsonFile(this.settingsPath, settings);
  }

  loadLegacyLayout(): Record<string, unknown> | undefined {
    return undefined;
  }

  clearLegacyLayout(): void {
    // Standalone mode never stored layouts in an adapter-specific legacy location.
  }

  private readWorkspaceState(): WorkspaceStateFile {
    return readJsonFile<WorkspaceStateFile>(this.workspaceStatePath, {
      workspaceDir: this.workspaceDir,
      ...DEFAULT_WORKSPACE_STATE,
    });
  }

  private writeWorkspaceState(state: WorkspaceStateFile): void {
    writeJsonFile(this.workspaceStatePath, state);
  }
}
