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
import type { OfficeLayout } from '../core/src/schemas.js';
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
import {
  migrateAndLoadLayout,
  watchLayoutFile,
  writeLayoutToFile,
} from '../server/src/layoutPersistence.js';
import { claudeProvider, copyHookScript } from '../server/src/providers/index.js';
import { PixelAgentsServer } from '../server/src/server.js';
import { SessionRouter } from '../server/src/sessionRouter.js';
import { setHookProvider } from '../server/src/transcriptParser.js';
import type { AgentState } from '../server/src/types.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { NullTerminalAdapter } from './nullTerminalAdapter.js';
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
    this.wsServer = new StandaloneWebSocketServer(this.browserServer, (clientId, message) => {
      void this.handleClientMessage(clientId, message);
    });
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.restorePersistedAgents();
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

  private async handleClientMessage(clientId: number, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'webviewReady':
        this.sendBootstrap(clientId);
        return;
      case 'saveAgentSeats':
        this.adapter.saveSeats(
          Object.fromEntries(
            Object.entries(message.seats).map(([agentId, seat]) => [
              agentId,
              {
                palette: seat.palette,
                hueShift: seat.hueShift,
                seatId: seat.seatId ?? undefined,
              },
            ]),
          ),
        );
        return;
      case 'saveLayout':
        this.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(message.layout as unknown as Record<string, unknown>);
        this.wsServer.broadcast({ type: 'layoutLoaded', layout: message.layout as OfficeLayout });
        return;
      case 'setSoundEnabled':
        this.adapter.setSetting(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
        return;
      case 'setLastSeenVersion':
        this.adapter.setSetting(GLOBAL_KEY_LAST_SEEN_VERSION, message.version);
        return;
      case 'setAlwaysShowLabels':
        this.adapter.setSetting(GLOBAL_KEY_ALWAYS_SHOW_LABELS, message.enabled);
        return;
      case 'setWatchAllSessions':
        this.adapter.setSetting(GLOBAL_KEY_WATCH_ALL_SESSIONS, message.enabled);
        this.watchAllSessions.current = message.enabled;
        return;
      case 'setHooksEnabled':
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_ENABLED, message.enabled);
        this.hooksEnabled.current = message.enabled;
        if (message.enabled) {
          const hookConfig = this.pixelAgentsServer?.getConfig();
          if (hookConfig) {
            await claudeProvider.installHooks(
              `http://127.0.0.1:${hookConfig.port}`,
              hookConfig.token,
            );
            copyHookScript(this.options.repoRoot);
          }
        } else {
          await claudeProvider.uninstallHooks();
        }
        return;
      case 'setHooksInfoShown':
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_INFO_SHOWN, true);
        return;
      case 'requestDiagnostics':
        this.wsServer.send(clientId, {
          type: 'agentDiagnostics',
          agents: [...this.store.values()].map((agent) => {
            let jsonlExists = false;
            let fileSize = 0;

            if (agent.jsonlFile) {
              try {
                const stat = fs.statSync(agent.jsonlFile);
                jsonlExists = true;
                fileSize = stat.size;
              } catch {
                jsonlExists = false;
              }
            }

            return {
              id: agent.id,
              projectDir: agent.projectDir,
              projectDirExists: fs.existsSync(agent.projectDir),
              jsonlFile: agent.jsonlFile,
              jsonlExists,
              fileSize,
              fileOffset: agent.fileOffset,
              lastDataAt: agent.lastDataAt,
              linesProcessed: agent.linesProcessed,
            };
          }),
        });
        return;
      case 'closeAgent': {
        const agent = this.store.get(message.id);
        if (agent?.jsonlFile) {
          this.dismissalTracker.dismiss(agent.jsonlFile);
        }
        this.removeTrackedAgent(message.id);
        return;
      }
      case 'focusAgent':
      case 'launchAgent':
      case 'openSessionsFolder':
      case 'exportLayout':
      case 'importLayout':
      case 'addExternalAssetDirectory':
      case 'removeExternalAssetDirectory':
        console.log(`[Pixel Agents] Standalone host ignoring unsupported message: ${message.type}`);
        return;
      default:
        // Relay: external clients (e.g. Node-RED) can push ServerMessage events by sending
        // them as-is. Broadcast to all connected clients so the webview sees them.
        this.wsServer.broadcast(message as unknown as ServerMessage);
    }
  }

  private sendBootstrap(clientId: number): void {
    const send = (message: ServerMessage) => this.wsServer.send(clientId, message);

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

    const layout = migrateAndLoadLayout(this.adapter, this.defaultLayout);
    send({
      type: 'layoutLoaded',
      layout: (layout?.layout as OfficeLayout | undefined) ?? null,
      wasReset: layout?.wasReset ?? false,
    });

    const sink = createMessageSink(send);
    this.sendExistingAgents(sink);
    this.sendCurrentAgentStatuses(sink);
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
}
