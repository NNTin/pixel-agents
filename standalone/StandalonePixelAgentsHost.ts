import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type * as vscode from 'vscode';

import { readConfig } from '../adapters/vscode/configPersistence.js';
import { GLOBAL_KEY_ALWAYS_SHOW_LABELS } from '../adapters/vscode/constants.js';
import { GLOBAL_KEY_HOOKS_ENABLED } from '../adapters/vscode/constants.js';
import { GLOBAL_KEY_HOOKS_INFO_SHOWN } from '../adapters/vscode/constants.js';
import { GLOBAL_KEY_LAST_SEEN_VERSION } from '../adapters/vscode/constants.js';
import { GLOBAL_KEY_SOUND_ENABLED } from '../adapters/vscode/constants.js';
import { GLOBAL_KEY_WATCH_ALL_SESSIONS } from '../adapters/vscode/constants.js';
import type { StateAdapter } from '../core/src/adapter.js';
import type { ClientMessage, ServerMessage } from '../core/src/messages.js';
import type {
  OfficeLayout,
  PersistedOverlayAgent,
  PersistedOverlayState,
  PersistedOverlaySubagentState,
  PersistedOverlaySubagentToolState,
  PersistedOverlayToolState,
} from '../core/src/schemas.js';
import { AgentStateStore } from '../server/src/agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites } from '../server/src/assetLoader.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadExternalCharacterSprites,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
  mergeCharacterSprites,
  mergeLoadedAssets,
} from '../server/src/assetLoader.js';
import { DismissalTracker } from '../server/src/dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setTeamProvider,
  setTerminalAdapter,
  startFileWatching,
} from '../server/src/fileWatcher.js';
import type { HookEvent } from '../server/src/hookEventHandler.js';
import { HookEventHandler } from '../server/src/hookEventHandler.js';
import type { LayoutWatcher } from '../server/src/layoutPersistence.js';
import { migrateAndLoadLayout, watchLayoutFile } from '../server/src/layoutPersistence.js';
import { claudeProvider, copyHookScript } from '../server/src/providers/index.js';
import { PixelAgentsServer } from '../server/src/server.js';
import { SessionRouter } from '../server/src/sessionRouter.js';
import { setHookProvider } from '../server/src/transcriptParser.js';
import type { AgentState } from '../server/src/types.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { NullTerminalAdapter } from './nullTerminalAdapter.js';
import type { ClientRole } from './webSocketServer.js';
import { StandaloneWebSocketServer } from './webSocketServer.js';

type LoadedFloorTiles = Awaited<ReturnType<typeof loadFloorTiles>>;
type LoadedWallTiles = Awaited<ReturnType<typeof loadWallTiles>>;

export interface StandaloneHostOptions {
  port: number;
  host: string;
  workspaceDir: string;
  assetsRoot: string;
  repoRoot: string;
}

function readPackageVersion(repoRoot: string): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'),
    ) as { version?: string };
    return packageJson.version ?? '';
  } catch (error) {
    console.error('[Pixel Agents] Failed to read package version:', error);
    return '';
  }
}

function toSpritesObject(assets: LoadedAssets): Record<string, string[][]> {
  const sprites: Record<string, string[][]> = {};
  for (const [assetId, spriteData] of assets.sprites) {
    sprites[assetId] = spriteData;
  }
  return sprites;
}

interface OverlayToolState {
  toolId: string;
  status: string;
  toolName?: string;
  done: boolean;
  permissionActive: boolean;
  runInBackground: boolean;
}

interface OverlaySubagentToolState {
  toolId: string;
  status: string;
  done: boolean;
}

interface OverlaySubagentState {
  parentToolId: string;
  permissionActive: boolean;
  tools: Record<string, OverlaySubagentToolState>;
}

interface OverlayAgentState {
  id: number;
  folderName?: string;
  isExternal: boolean;
  isTeammate: boolean;
  teammateName?: string;
  parentAgentId?: number;
  teamName?: string;
  hooksOnly: boolean;
  selected: boolean;
  status: 'active' | 'waiting';
  permissionActive: boolean;
  tools: Record<string, OverlayToolState>;
  subagents: Record<string, OverlaySubagentState>;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
  inputTokens: number;
  outputTokens: number;
}

function createOverlayAgentState(id: number): OverlayAgentState {
  return {
    id,
    isExternal: false,
    isTeammate: false,
    hooksOnly: false,
    selected: false,
    status: 'active',
    permissionActive: false,
    tools: {},
    subagents: {},
    inputTokens: 0,
    outputTokens: 0,
  };
}

function toOverlaySubagentState(
  persisted: PersistedOverlaySubagentState,
): OverlaySubagentState | null {
  if (!persisted.parentToolId) {
    return null;
  }

  const tools: Record<string, OverlaySubagentToolState> = {};
  for (const tool of persisted.tools) {
    if (!tool.toolId || !tool.status) {
      continue;
    }
    tools[tool.toolId] = {
      toolId: tool.toolId,
      status: tool.status,
      done: !!tool.done,
    };
  }

  return {
    parentToolId: persisted.parentToolId,
    permissionActive: !!persisted.permissionActive,
    tools,
  };
}

function toOverlayAgentState(persisted: PersistedOverlayAgent): OverlayAgentState {
  const tools: Record<string, OverlayToolState> = {};
  for (const tool of persisted.tools) {
    if (!tool.toolId || !tool.status) {
      continue;
    }
    tools[tool.toolId] = {
      toolId: tool.toolId,
      status: tool.status,
      toolName: tool.toolName,
      done: !!tool.done,
      permissionActive: !!tool.permissionActive,
      runInBackground: !!tool.runInBackground,
    };
  }

  const subagents: Record<string, OverlaySubagentState> = {};
  for (const subagent of persisted.subagents) {
    const restored = toOverlaySubagentState(subagent);
    if (!restored) {
      continue;
    }
    subagents[restored.parentToolId] = restored;
  }

  return {
    id: persisted.id,
    folderName: persisted.folderName,
    isExternal: !!persisted.isExternal,
    isTeammate: !!persisted.isTeammate,
    teammateName: persisted.teammateName,
    parentAgentId: persisted.parentAgentId,
    teamName: persisted.teamName,
    hooksOnly: !!persisted.hooksOnly,
    selected: !!persisted.selected,
    status: persisted.status === 'waiting' ? 'waiting' : 'active',
    permissionActive: !!persisted.permissionActive,
    tools,
    subagents,
    agentName: persisted.agentName,
    isTeamLead: persisted.isTeamLead,
    leadAgentId: persisted.leadAgentId,
    teamUsesTmux: persisted.teamUsesTmux,
    inputTokens: persisted.inputTokens ?? 0,
    outputTokens: persisted.outputTokens ?? 0,
  };
}

function serializeOverlaySubagentState(state: OverlaySubagentState): PersistedOverlaySubagentState {
  const tools: PersistedOverlaySubagentToolState[] = Object.values(state.tools)
    .sort((left, right) => left.toolId.localeCompare(right.toolId))
    .map((tool) => ({
      toolId: tool.toolId,
      status: tool.status,
      done: tool.done || undefined,
    }));

  return {
    parentToolId: state.parentToolId,
    permissionActive: state.permissionActive || undefined,
    tools,
  };
}

function serializeOverlayAgentState(state: OverlayAgentState): PersistedOverlayAgent {
  const tools: PersistedOverlayToolState[] = Object.values(state.tools)
    .sort((left, right) => left.toolId.localeCompare(right.toolId))
    .map((tool) => ({
      toolId: tool.toolId,
      status: tool.status,
      toolName: tool.toolName,
      done: tool.done || undefined,
      permissionActive: tool.permissionActive || undefined,
      runInBackground: tool.runInBackground || undefined,
    }));

  const subagents: PersistedOverlaySubagentState[] = Object.values(state.subagents)
    .sort((left, right) => left.parentToolId.localeCompare(right.parentToolId))
    .map(serializeOverlaySubagentState);

  return {
    id: state.id,
    folderName: state.folderName,
    isExternal: state.isExternal || undefined,
    isTeammate: state.isTeammate || undefined,
    teammateName: state.teammateName,
    parentAgentId: state.parentAgentId,
    teamName: state.teamName,
    hooksOnly: state.hooksOnly || undefined,
    selected: state.selected || undefined,
    status: state.status === 'waiting' ? 'waiting' : undefined,
    permissionActive: state.permissionActive || undefined,
    tools,
    subagents,
    agentName: state.agentName,
    isTeamLead: state.isTeamLead,
    leadAgentId: state.leadAgentId,
    teamUsesTmux: state.teamUsesTmux,
    inputTokens: state.inputTokens > 0 ? state.inputTokens : undefined,
    outputTokens: state.outputTokens > 0 ? state.outputTokens : undefined,
  };
}

function toCreatedMessage(
  agent: OverlayAgentState,
): Extract<ServerMessage, { type: 'agentCreated' }> {
  return {
    type: 'agentCreated',
    id: agent.id,
    folderName: agent.folderName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.isTeammate || undefined,
    teammateName: agent.teammateName,
    parentAgentId: agent.parentAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
  };
}

function removeStoredAgent(
  agentId: number,
  store: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
  if (!store.get(agentId)) {
    return;
  }

  const jsonlTimer = jsonlPollTimers.get(agentId);
  if (jsonlTimer) {
    clearInterval(jsonlTimer);
  }
  jsonlPollTimers.delete(agentId);

  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);

  const pollTimer = pollingTimers.get(agentId);
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollingTimers.delete(agentId);

  const waitingTimer = waitingTimers.get(agentId);
  if (waitingTimer) {
    clearTimeout(waitingTimer);
  }
  waitingTimers.delete(agentId);

  const permissionTimer = permissionTimers.get(agentId);
  if (permissionTimer) {
    clearTimeout(permissionTimer);
  }
  permissionTimers.delete(agentId);

  store.delete(agentId);
  store.persist();
}

function createMessageSink(
  send: (message: ServerMessage) => void,
): vscode.Webview & { postMessage(message: ServerMessage): void } {
  return {
    postMessage(message: ServerMessage): void {
      send(message);
    },
  } as unknown as vscode.Webview & { postMessage(message: ServerMessage): void };
}

export class StandalonePixelAgentsHost {
  private readonly adapter: StateAdapter;
  private readonly store = new AgentStateStore();
  private readonly overlayAgents = new Map<number, OverlayAgentState>();
  private readonly dismissalTracker = new DismissalTracker();
  private readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly fileWatchers = new Map<number, fs.FSWatcher>();
  private readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly knownJsonlFiles = new Set<string>();
  private readonly watchAllSessions = { current: true };
  private readonly hooksEnabled = { current: true };
  private readonly extensionVersion: string;

  private readonly browserServer: http.Server;
  private readonly wsServer: StandaloneWebSocketServer;
  private pixelAgentsServer: PixelAgentsServer | null = null;
  private hookEventHandler: HookEventHandler | null = null;
  private layoutWatcher: LayoutWatcher | null = null;

  private defaultLayout: Record<string, unknown> | null = null;
  private charSprites: LoadedCharacterSprites | null = null;
  private floorTiles: LoadedFloorTiles = null;
  private wallTiles: LoadedWallTiles = null;
  private furnitureAssets: LoadedAssets | null = null;
  private startedAt = Date.now();

  constructor(private readonly options: StandaloneHostOptions) {
    this.adapter = new FileStateAdapter(options.workspaceDir);
    this.extensionVersion = readPackageVersion(options.repoRoot);
    this.store.setAdapter(this.adapter);

    setDismissalTracker(this.dismissalTracker);
    setTerminalAdapter(new NullTerminalAdapter());
    setAgentRemovalCallback((agentId) => this.removeTrackedAgent(agentId));
    if (claudeProvider.team) {
      setTeamProvider(claudeProvider.team);
    }
    setHookProvider(claudeProvider);
    setFileWatcherHookProvider(claudeProvider);

    this.store.on('agentAdded', (id, agent) => {
      this.wsServer.broadcast({
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
      });
    });
    this.store.on('agentRemoved', (id) => {
      this.wsServer.broadcast({ type: 'agentClosed', id });
    });
    this.store.on('broadcast', (message) => {
      this.wsServer.broadcast(message as ServerMessage);
    });

    this.browserServer = http.createServer((request, response) => {
      this.handleBrowserRequest(request, response);
    });
    this.wsServer = new StandaloneWebSocketServer(
      this.browserServer,
      (clientId, role, message) => {
        void this.handleClientMessage(clientId, role, message);
      },
      (clientId, role) => {
        if (role === 'producer') {
          this.requestProducerBootstrap(clientId);
        }
      },
    );
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.restorePersistedAgents();
    this.restorePersistedOverlayState();
    await this.reloadAssets();
    await this.startHookServer();
    await new Promise<void>((resolve, reject) => {
      this.browserServer.once('error', reject);
      this.browserServer.listen(this.options.port, this.options.host, () => {
        this.browserServer.removeListener('error', reject);
        resolve();
      });
    });
    this.startLayoutWatcher();
    console.log(
      `[Pixel Agents] Standalone host ready on http://${this.options.host}:${this.options.port}`,
    );
  }

  async stop(): Promise<void> {
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    this.hookEventHandler?.dispose();
    this.hookEventHandler = null;
    this.pixelAgentsServer?.stop();
    this.pixelAgentsServer = null;
    this.wsServer.close();

    await new Promise<void>((resolve) => {
      if (!this.browserServer.listening) {
        resolve();
        return;
      }
      this.browserServer.close(() => resolve());
    });

    for (const agentId of [...this.store.keys()]) {
      this.removeTrackedAgent(agentId);
    }
    this.store.dispose();
  }

  private async startHookServer(): Promise<void> {
    this.hookEventHandler = new HookEventHandler(
      this.store,
      this.waitingTimers,
      this.permissionTimers,
      claudeProvider,
      new SessionRouter(),
      this.watchAllSessions,
    );
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgentHook(agent),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        const agent = this.store.get(agentId);
        if (!agent) {
          return;
        }

        this.unregisterAgentHook(agent);
        agent.sessionId = newSessionId;
        if (newTranscriptPath) {
          agent.jsonlFile = newTranscriptPath;
        }
        this.registerAgentHook(agent);
        this.store.persist();
      },
      onSessionResume: (_transcriptPath) => {
        // Standalone mode does not seed dismissals via workspace scanners.
      },
      onSessionEnd: (agentId) => {
        this.removeTrackedAgent(agentId);
        for (const [id, agent] of this.store) {
          if (agent.leadAgentId === agentId) {
            this.removeTrackedAgent(id);
          }
        }
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTrackedAgent(teammateAgentId);
      },
    });

    this.pixelAgentsServer = new PixelAgentsServer();
    this.pixelAgentsServer.onHookEvent((providerId, event) => {
      this.hookEventHandler?.handleEvent(providerId, event as HookEvent);
    });
    const hookConfig = await this.pixelAgentsServer.start();

    const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
    this.hooksEnabled.current = hooksEnabled;
    if (hooksEnabled) {
      await claudeProvider.installHooks(`http://127.0.0.1:${hookConfig.port}`, hookConfig.token);
      copyHookScript(this.options.repoRoot);
    }
  }

  private async reloadAssets(): Promise<void> {
    this.defaultLayout = loadDefaultLayout(this.options.assetsRoot);

    this.charSprites = await loadCharacterSprites(this.options.assetsRoot);
    const config = readConfig();
    for (const externalDir of config.externalAssetDirectories) {
      const extra = await loadExternalCharacterSprites(externalDir);
      if (extra) {
        this.charSprites = this.charSprites
          ? mergeCharacterSprites(this.charSprites, extra)
          : extra;
      }
    }

    this.floorTiles = await loadFloorTiles(this.options.assetsRoot);
    this.wallTiles = await loadWallTiles(this.options.assetsRoot);
    this.furnitureAssets = await loadFurnitureAssets(this.options.assetsRoot);
    for (const externalDir of config.externalAssetDirectories) {
      const extraAssets = await loadFurnitureAssets(externalDir);
      if (extraAssets) {
        this.furnitureAssets = this.furnitureAssets
          ? mergeLoadedAssets(this.furnitureAssets, extraAssets)
          : extraAssets;
      }
    }
  }

  private restorePersistedAgents(): void {
    const persisted = this.adapter.loadAgents();
    let maxAgentId = 0;

    for (const persistedAgent of persisted) {
      if (!persistedAgent.isExternal && persistedAgent.terminalName) {
        continue;
      }

      if (persistedAgent.jsonlFile && !fs.existsSync(persistedAgent.jsonlFile)) {
        continue;
      }

      const agent: AgentState = {
        id: persistedAgent.id,
        sessionId:
          persistedAgent.sessionId ||
          (persistedAgent.jsonlFile ? path.basename(persistedAgent.jsonlFile, '.jsonl') : ''),
        terminalRef: undefined,
        isExternal: true,
        projectDir: persistedAgent.projectDir,
        jsonlFile: persistedAgent.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        backgroundAgentToolIds: new Set(),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        folderName: persistedAgent.folderName,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        hookDelivered: false,
        hooksOnly: persistedAgent.jsonlFile === '',
        inputTokens: 0,
        outputTokens: 0,
        teamName: persistedAgent.teamName,
        agentName: persistedAgent.agentName,
        isTeamLead: persistedAgent.isTeamLead,
        leadAgentId: persistedAgent.leadAgentId,
        teamUsesTmux: persistedAgent.teamUsesTmux,
      };

      this.store.set(agent.id, agent);
      this.registerAgentHook(agent);
      if (agent.jsonlFile) {
        const stat = fs.statSync(agent.jsonlFile);
        agent.fileOffset = stat.size;
        this.knownJsonlFiles.add(agent.jsonlFile);
        startFileWatching(
          agent.id,
          agent.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      }

      maxAgentId = Math.max(maxAgentId, agent.id);
    }

    if (maxAgentId > 0) {
      this.store.nextAgentId.current = maxAgentId + 1;
    }
  }

  private restorePersistedOverlayState(): void {
    const persisted = this.adapter.loadOverlayState();
    for (const agent of persisted.agents) {
      this.overlayAgents.set(agent.id, toOverlayAgentState(agent));
    }
  }

  private persistOverlayState(): void {
    const state: PersistedOverlayState = {
      agents: [...this.overlayAgents.values()]
        .sort((left, right) => left.id - right.id)
        .map(serializeOverlayAgentState),
    };
    this.adapter.saveOverlayState(state);
  }

  private handleBrowserRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (request.method === 'GET' && request.url === '/api/health') {
      const browserAddress = this.browserServer.address();
      const browserPort =
        typeof browserAddress === 'object' && browserAddress
          ? browserAddress.port
          : this.options.port;
      const hookPort = this.pixelAgentsServer?.getConfig()?.port ?? null;

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          browserPort,
          hookPort,
          workspaceDir: this.options.workspaceDir,
          assetsRoot: this.options.assetsRoot,
          uptime: Math.floor((Date.now() - this.startedAt) / 1000),
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  }

  private async handleClientMessage(
    clientId: number,
    role: ClientRole,
    message: ClientMessage,
  ): Promise<void> {
    if (role === 'producer') {
      this.handleProducerMessage(message as unknown as ServerMessage);
      return;
    }

    // Viewer path: only webviewReady is handled; all other messages are dropped.
    switch (message.type) {
      case 'webviewReady':
        this.sendBootstrap(clientId);
        return;
      default:
        console.log(`[Pixel Agents] Viewer dropped read-only-restricted message: ${message.type}`);
    }
  }

  private sendBootstrap(clientId: number): void {
    const send = (message: ServerMessage) => this.wsServer.send(clientId, message);
    const sink = createMessageSink(send);

    send({
      type: 'providerCapabilities',
      readingTools: [...claudeProvider.readingTools],
      subagentToolNames: [...claudeProvider.subagentToolNames],
    });

    send({
      type: 'settingsLoaded',
      soundEnabled: this.adapter.getSetting<boolean>(GLOBAL_KEY_SOUND_ENABLED, true),
      lastSeenVersion: this.adapter.getSetting<string>(GLOBAL_KEY_LAST_SEEN_VERSION, ''),
      extensionVersion: this.extensionVersion,
      watchAllSessions: this.adapter.getSetting<boolean>(GLOBAL_KEY_WATCH_ALL_SESSIONS, true),
      alwaysShowLabels: this.adapter.getSetting<boolean>(GLOBAL_KEY_ALWAYS_SHOW_LABELS, false),
      hooksEnabled: this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true),
      hooksInfoShown: this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_INFO_SHOWN, false),
      externalAssetDirectories: readConfig().externalAssetDirectories,
    });

    if (this.charSprites) {
      send({
        type: 'characterSpritesLoaded',
        characters: this.charSprites.characters,
      });
    }
    if (this.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: this.floorTiles.sprites });
    }
    if (this.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: this.wallTiles.sets });
    }
    if (this.furnitureAssets) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: this.furnitureAssets.catalog,
        sprites: toSpritesObject(this.furnitureAssets),
      });
    }

    this.sendExistingAgents(sink);
    this.sendOverlayExistingAgents(sink);

    const layout = migrateAndLoadLayout(this.adapter, this.defaultLayout);
    send({
      type: 'layoutLoaded',
      layout: (layout?.layout as OfficeLayout | undefined) ?? null,
      wasReset: layout?.wasReset ?? false,
    });

    this.sendCurrentAgentStatuses(sink);
    this.sendCurrentOverlayState(sink);
  }

  private sendExistingAgents(webview: vscode.Webview): void {
    const agentIds = [...this.store.keys()].sort((left, right) => left - right);
    const agentMeta = this.adapter.loadSeats();
    const folderNames: Record<number, string> = {};
    const externalAgents: Record<number, boolean> = {};

    for (const [id, agent] of this.store) {
      if (agent.folderName) {
        folderNames[id] = agent.folderName;
      }
      if (agent.isExternal) {
        externalAgents[id] = true;
      }
    }

    webview.postMessage({
      type: 'existingAgents',
      agents: agentIds,
      agentMeta,
      folderNames,
      externalAgents,
    });
  }

  private sendCurrentAgentStatuses(webview: vscode.Webview): void {
    for (const [agentId, agent] of this.store) {
      for (const [toolId, status] of agent.activeToolStatuses) {
        webview.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          status,
          toolName: agent.activeToolNames.get(toolId) ?? '',
        });
      }

      if (agent.isWaiting) {
        webview.postMessage({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
        });
      }

      if (agent.teamName) {
        webview.postMessage({
          type: 'agentTeamInfo',
          id: agentId,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
          teamUsesTmux: agent.teamUsesTmux,
        });
      }

      if (agent.inputTokens > 0 || agent.outputTokens > 0) {
        webview.postMessage({
          type: 'agentTokenUsage',
          id: agentId,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
        });
      }
    }
  }

  private sendOverlayExistingAgents(webview: vscode.Webview): void {
    const agentIds: number[] = [];
    const folderNames: Record<number, string> = {};
    const externalAgents: Record<number, boolean> = {};

    for (const [id, agent] of [...this.overlayAgents.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      if (agent.isTeammate && agent.parentAgentId !== undefined) {
        continue;
      }
      agentIds.push(id);
      if (agent.folderName) {
        folderNames[id] = agent.folderName;
      }
      if (agent.isExternal) {
        externalAgents[id] = true;
      }
    }

    if (agentIds.length === 0) {
      return;
    }

    webview.postMessage({
      type: 'existingAgents',
      agents: agentIds,
      agentMeta: {},
      folderNames,
      externalAgents,
    });
  }

  private sendCurrentOverlayState(webview: vscode.Webview): void {
    const agents = [...this.overlayAgents.values()].sort((left, right) => left.id - right.id);

    for (const agent of agents) {
      if (agent.isTeammate && agent.parentAgentId !== undefined) {
        webview.postMessage(toCreatedMessage(agent));
      }
    }

    for (const agent of agents) {
      const tools = Object.values(agent.tools).sort((left, right) =>
        left.toolId.localeCompare(right.toolId),
      );
      for (const tool of tools) {
        webview.postMessage({
          type: 'agentToolStart',
          id: agent.id,
          toolId: tool.toolId,
          status: tool.status,
          toolName: tool.toolName,
          permissionActive: tool.permissionActive || undefined,
          runInBackground: tool.runInBackground || undefined,
        });
        if (tool.done) {
          webview.postMessage({
            type: 'agentToolDone',
            id: agent.id,
            toolId: tool.toolId,
          });
        }
      }

      if (agent.permissionActive) {
        webview.postMessage({
          type: 'agentToolPermission',
          id: agent.id,
        });
      }

      const subagents = Object.values(agent.subagents).sort((left, right) =>
        left.parentToolId.localeCompare(right.parentToolId),
      );
      for (const subagent of subagents) {
        const subagentTools = Object.values(subagent.tools).sort((left, right) =>
          left.toolId.localeCompare(right.toolId),
        );
        for (const tool of subagentTools) {
          webview.postMessage({
            type: 'subagentToolStart',
            id: agent.id,
            parentToolId: subagent.parentToolId,
            toolId: tool.toolId,
            status: tool.status,
          });
          if (tool.done) {
            webview.postMessage({
              type: 'subagentToolDone',
              id: agent.id,
              parentToolId: subagent.parentToolId,
              toolId: tool.toolId,
            });
          }
        }
        if (subagent.permissionActive) {
          webview.postMessage({
            type: 'subagentToolPermission',
            id: agent.id,
            parentToolId: subagent.parentToolId,
          });
        }
      }

      if (agent.status === 'waiting') {
        webview.postMessage({
          type: 'agentStatus',
          id: agent.id,
          status: 'waiting',
        });
      }

      if (agent.selected) {
        webview.postMessage({
          type: 'agentSelected',
          id: agent.id,
        });
      }

      if (
        agent.teamName ||
        agent.agentName ||
        agent.isTeamLead !== undefined ||
        agent.leadAgentId !== undefined ||
        agent.teamUsesTmux !== undefined
      ) {
        webview.postMessage({
          type: 'agentTeamInfo',
          id: agent.id,
          teamName: agent.teamName,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
          teamUsesTmux: agent.teamUsesTmux,
        });
      }

      if (agent.inputTokens > 0 || agent.outputTokens > 0) {
        webview.postMessage({
          type: 'agentTokenUsage',
          id: agent.id,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
        });
      }
    }
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) {
      return;
    }
    this.layoutWatcher = watchLayoutFile((layout) => {
      this.wsServer.broadcast({ type: 'layoutLoaded', layout: layout as unknown as OfficeLayout });
    });
  }

  private registerAgentHook(agent: AgentState): void {
    if (agent.leadAgentId !== undefined) {
      return;
    }
    this.hookEventHandler?.registerAgent(agent.sessionId, agent.id);
  }

  private unregisterAgentHook(agent: AgentState): void {
    this.hookEventHandler?.unregisterAgent(agent.sessionId);
  }

  private removeTrackedAgent(agentId: number): void {
    const agent = this.store.get(agentId);
    if (!agent) {
      return;
    }
    this.unregisterAgentHook(agent);
    removeStoredAgent(
      agentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
    );
  }

  private requestProducerBootstrap(clientId: number): void {
    this.wsServer.send(clientId, { type: 'producerBootstrapRequest' });
  }

  private ensureOverlayAgent(id: number): OverlayAgentState {
    const existing = this.overlayAgents.get(id);
    if (existing) {
      return existing;
    }

    const created = createOverlayAgentState(id);
    this.overlayAgents.set(id, created);
    return created;
  }

  private getOverlaySubagentState(
    agent: OverlayAgentState,
    parentToolId: string,
  ): OverlaySubagentState {
    const existing = agent.subagents[parentToolId];
    if (existing) {
      return existing;
    }

    const created: OverlaySubagentState = {
      parentToolId,
      permissionActive: false,
      tools: {},
    };
    agent.subagents[parentToolId] = created;
    return created;
  }

  private handleProducerMessage(message: ServerMessage): void {
    for (const outbound of this.applyProducerMessage(message)) {
      this.wsServer.broadcast(outbound);
    }
  }

  private applyProducerMessage(message: ServerMessage): ServerMessage[] {
    switch (message.type) {
      case 'agentCreated': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.folderName = message.folderName ?? agent.folderName;
        agent.isExternal = !!message.isExternal;
        agent.isTeammate = !!message.isTeammate;
        agent.teammateName = message.teammateName ?? agent.teammateName;
        agent.parentAgentId = message.parentAgentId ?? agent.parentAgentId;
        agent.teamName = message.teamName ?? agent.teamName;
        agent.hooksOnly = !!message.hooksOnly;
        this.persistOverlayState();
        return [message];
      }
      case 'agentClosed': {
        if (this.overlayAgents.delete(message.id)) {
          this.persistOverlayState();
        }
        return [message];
      }
      case 'agentSelected': {
        this.ensureOverlayAgent(message.id);
        for (const candidate of this.overlayAgents.values()) {
          candidate.selected = candidate.id === message.id;
        }
        this.persistOverlayState();
        return [message];
      }
      case 'existingAgents': {
        return this.applyProducerExistingAgents(message);
      }
      case 'agentStatus': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.status = message.status;
        this.persistOverlayState();
        return [message];
      }
      case 'agentToolStart': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.tools[message.toolId] = {
          toolId: message.toolId,
          status: message.status,
          toolName: message.toolName,
          done: false,
          permissionActive: !!message.permissionActive,
          runInBackground: !!message.runInBackground,
        };
        this.persistOverlayState();
        return [message];
      }
      case 'agentToolDone': {
        const agent = this.ensureOverlayAgent(message.id);
        const tool = agent.tools[message.toolId];
        if (tool) {
          tool.done = true;
          this.persistOverlayState();
        }
        return [message];
      }
      case 'agentToolsClear': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.permissionActive = false;
        agent.tools = {};
        agent.subagents = {};
        this.persistOverlayState();
        return [message];
      }
      case 'agentToolPermission': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.permissionActive = true;
        for (const tool of Object.values(agent.tools)) {
          if (!tool.done) {
            tool.permissionActive = true;
          }
        }
        this.persistOverlayState();
        return [message];
      }
      case 'agentToolPermissionClear': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.permissionActive = false;
        for (const tool of Object.values(agent.tools)) {
          tool.permissionActive = false;
        }
        this.persistOverlayState();
        return [message];
      }
      case 'subagentToolStart': {
        const agent = this.ensureOverlayAgent(message.id);
        const subagent = this.getOverlaySubagentState(agent, message.parentToolId);
        subagent.tools[message.toolId] = {
          toolId: message.toolId,
          status: message.status,
          done: false,
        };
        this.persistOverlayState();
        return [message];
      }
      case 'subagentToolDone': {
        const agent = this.ensureOverlayAgent(message.id);
        const tool = agent.subagents[message.parentToolId]?.tools[message.toolId];
        if (tool) {
          tool.done = true;
          this.persistOverlayState();
        }
        return [message];
      }
      case 'subagentClear': {
        const agent = this.ensureOverlayAgent(message.id);
        if (agent.subagents[message.parentToolId]) {
          delete agent.subagents[message.parentToolId];
          this.persistOverlayState();
        }
        return [message];
      }
      case 'subagentToolPermission': {
        const agent = this.ensureOverlayAgent(message.id);
        const subagent = this.getOverlaySubagentState(agent, message.parentToolId);
        subagent.permissionActive = true;
        this.persistOverlayState();
        return [message];
      }
      case 'agentTeamInfo': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.teamName = message.teamName ?? agent.teamName;
        agent.agentName = message.agentName ?? agent.agentName;
        agent.isTeamLead = message.isTeamLead;
        agent.leadAgentId = message.leadAgentId;
        agent.teamUsesTmux = message.teamUsesTmux;
        this.persistOverlayState();
        return [message];
      }
      case 'agentTokenUsage': {
        const agent = this.ensureOverlayAgent(message.id);
        agent.inputTokens = message.inputTokens;
        agent.outputTokens = message.outputTokens;
        this.persistOverlayState();
        return [message];
      }
      default:
        return [];
    }
  }

  private applyProducerExistingAgents(
    message: Extract<ServerMessage, { type: 'existingAgents' }>,
  ): ServerMessage[] {
    const nextIds = new Set(message.agents);
    const folderNames = message.folderNames ?? {};
    const externalAgents = message.externalAgents ?? {};
    const broadcasts: ServerMessage[] = [];
    let changed = false;

    for (const currentId of [...this.overlayAgents.keys()]) {
      if (!nextIds.has(currentId)) {
        this.overlayAgents.delete(currentId);
        broadcasts.push({ type: 'agentClosed', id: currentId });
        changed = true;
      }
    }

    for (const id of message.agents) {
      const alreadyHad = this.overlayAgents.has(id);
      const agent = this.ensureOverlayAgent(id);
      const nextFolderName = folderNames[id];
      const nextIsExternal = !!externalAgents[id];

      if (!alreadyHad) {
        agent.folderName = nextFolderName ?? agent.folderName;
        agent.isExternal = nextIsExternal;
        broadcasts.push(toCreatedMessage(agent));
        changed = true;
        continue;
      }

      if (nextFolderName !== undefined && nextFolderName !== agent.folderName) {
        agent.folderName = nextFolderName;
        changed = true;
      }
      if (agent.isExternal !== nextIsExternal) {
        agent.isExternal = nextIsExternal;
        changed = true;
      }
    }

    if (changed) {
      this.persistOverlayState();
    }

    return broadcasts;
  }
}
