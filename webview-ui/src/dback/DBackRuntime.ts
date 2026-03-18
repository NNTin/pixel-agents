/**
 * D-Back Browser Runtime
 *
 * Connects to a d-back WebSocket server and maps Discord users to pixel agents.
 * Dispatches pixel-agent messages via window.dispatchEvent so the React app
 * receives them through the same `window.addEventListener('message', ...)` hook
 * used by the VS Code extension bridge.
 *
 * Protocol (d-back WebSocket):
 *   Server → Client:
 *     { type: "server-list", data: { [discordId]: { id, name, passworded, default? } } }
 *     { type: "server-join", data: { users: { [uid]: { uid, username, status, roleColor } }, serverName } }
 *     { type: "presence",    server: "discordId", data: { uid, status } }
 *     { type: "message",     server: "discordId", data: { uid, message, channel } }
 *   Client → Server:
 *     { type: "connect", data: { server: "serverId" } }
 */

const DBACK_WS_URL = import.meta.env.VITE_DBACK_WS_URL as string | undefined;
const DBACK_SERVER = import.meta.env.VITE_DBACK_SERVER as string | undefined;

const DEFAULT_WS_URL = 'wss://hermes.nntin.xyz/dzone';
/** Server ID within d-back (matches server.id in the server-list response) */
const DEFAULT_SERVER = 'dworld';

/** How long (ms) a "chat message" tool animation stays active */
const MESSAGE_TOOL_DURATION_MS = 4000;

/** How long (ms) to wait before reconnecting after a disconnect */
const RECONNECT_DELAY_MS = 5000;

type DBackStatus = 'online' | 'idle' | 'dnd' | 'offline';

interface DBackUser {
  uid: string;
  username: string;
  status: DBackStatus;
  roleColor: string;
}

interface AgentEntry {
  id: number;
  uid: string;
  username: string;
  status: DBackStatus;
  /** Pending tool-done timer for simulated chat-message tool use */
  toolDoneTimer: ReturnType<typeof setTimeout> | null;
  /** Current active toolId for message simulation */
  activeToolId: string | null;
}

/** Dispatch a pixel-agents message via the window message bus */
function dispatch(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

export class DBackRuntime {
  private ws: WebSocket | null = null;
  private agents = new Map<string, AgentEntry>(); // uid → entry
  private nextId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** URL of the d-back WebSocket endpoint */
  private readonly wsUrl: string;
  /** d-back server ID to connect to (server.data.id, not Discord snowflake) */
  private readonly serverId: string;

  constructor(
    wsUrl = DBACK_WS_URL ?? DEFAULT_WS_URL,
    serverId = DBACK_SERVER ?? DEFAULT_SERVER,
  ) {
    this.wsUrl = wsUrl;
    this.serverId = serverId;
  }

  start(): void {
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const uid of [...this.agents.keys()]) {
      this.dropAgent(uid);
    }
    this.ws?.close();
    this.ws = null;
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────────────────

  private connect(): void {
    if (this.disposed) return;
    console.log(`[DBackRuntime] Connecting to ${this.wsUrl} (server: ${this.serverId})`);

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      console.error('[DBackRuntime] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[DBackRuntime] Connected');
      // Send connect request for our configured server
      this.ws!.send(
        JSON.stringify({ type: 'connect', data: { server: this.serverId } }),
      );
    };

    this.ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch (err) {
        console.warn('[DBackRuntime] Failed to parse message:', err);
      }
    };

    this.ws.onerror = (err) => {
      console.warn('[DBackRuntime] WebSocket error:', err);
    };

    this.ws.onclose = () => {
      console.log('[DBackRuntime] Disconnected');
      this.ws = null;
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    console.log(`[DBackRuntime] Reconnecting in ${RECONNECT_DELAY_MS}ms…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  // ── Protocol handling ────────────────────────────────────────────────────────

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === 'server-list') {
      // Server list received; connection request was already sent in onopen
      console.log('[DBackRuntime] Server list received');
    } else if (type === 'server-join') {
      const data = msg.data as {
        users: Record<string, DBackUser>;
        serverName: string;
      };
      console.log(`[DBackRuntime] Joined server "${data.serverName}" with ${Object.keys(data.users).length} users`);
      this.handleInitialUsers(data.users);
    } else if (type === 'presence') {
      const data = msg.data as { uid: string; status: DBackStatus };
      this.handlePresenceUpdate(data.uid, data.status);
    } else if (type === 'message') {
      const data = msg.data as { uid: string; message: string; channel: string };
      this.handleChatMessage(data.uid, data.message);
    } else if (type === 'error') {
      const data = msg.data as { message: string };
      console.error(`[DBackRuntime] Server error: ${data.message}`);
    }
  }

  // ── User → agent mapping ─────────────────────────────────────────────────────

  private handleInitialUsers(users: Record<string, DBackUser>): void {
    const agentIds: number[] = [];
    const agentMeta: Record<number, Record<string, never>> = {};

    for (const user of Object.values(users)) {
      // Skip already-tracked users (shouldn't happen on fresh connect)
      if (this.agents.has(user.uid)) continue;

      const id = this.nextId++;
      const entry: AgentEntry = {
        id,
        uid: user.uid,
        username: user.username,
        status: user.status,
        toolDoneTimer: null,
        activeToolId: null,
      };
      this.agents.set(user.uid, entry);
      agentIds.push(id);
      agentMeta[id] = {};
    }

    if (agentIds.length === 0) return;

    // Send all initial agents in one batch
    dispatch({ type: 'existingAgents', agents: agentIds, agentMeta, folderNames: {} });

    // Apply initial statuses
    for (const [uid, entry] of this.agents) {
      const user = users[uid];
      if (!user) continue;
      this.applyStatus(entry, user.status);
    }
  }

  private handlePresenceUpdate(uid: string, status: DBackStatus): void {
    const entry = this.agents.get(uid);
    if (!entry) return; // Unknown user — ignore

    if (entry.status === status) return; // No change
    entry.status = status;
    this.applyStatus(entry, status);
  }

  private handleChatMessage(uid: string, message: string): void {
    const entry = this.agents.get(uid);
    if (!entry) return;

    // If an existing tool animation is running, cancel it first
    if (entry.toolDoneTimer !== null) {
      clearTimeout(entry.toolDoneTimer);
      entry.toolDoneTimer = null;
      if (entry.activeToolId !== null) {
        dispatch({ type: 'agentToolDone', id: entry.id, toolId: entry.activeToolId });
        entry.activeToolId = null;
      }
    }

    const toolId = `msg-${Date.now().toString()}-${uid}`;
    entry.activeToolId = toolId;

    // Simulate writing a message (Write tool → typing animation)
    dispatch({
      type: 'agentToolStart',
      id: entry.id,
      toolId,
      status: `Writing "${message.length > 30 ? `${message.slice(0, 30)}…` : message}"`,
    });

    entry.toolDoneTimer = setTimeout(() => {
      entry.toolDoneTimer = null;
      if (entry.activeToolId === toolId) {
        entry.activeToolId = null;
        dispatch({ type: 'agentToolDone', id: entry.id, toolId });
      }
    }, MESSAGE_TOOL_DURATION_MS);
  }

  private applyStatus(entry: AgentEntry, status: DBackStatus): void {
    if (status === 'dnd') {
      // DND → show as waiting (blocked / do not disturb)
      dispatch({ type: 'agentStatus', id: entry.id, status: 'waiting' });
    }
    // online / idle / offline → no special status; agent wanders the office
    // (offline is treated as idle rather than removing the agent)
  }

  /** Cleanly remove an agent by uid (used on dispose only) */
  private dropAgent(uid: string): void {
    const entry = this.agents.get(uid);
    if (!entry) return;
    if (entry.toolDoneTimer !== null) {
      clearTimeout(entry.toolDoneTimer);
      entry.toolDoneTimer = null;
    }
    this.agents.delete(uid);
  }
}
