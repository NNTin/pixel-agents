import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';

type BrowserGlobals = typeof globalThis & {
  location?: { href?: string };
};

/**
 * WebSocket transport for standalone browser mode.
 * Connects to the Pixel Agents server via WebSocket for bidirectional messaging.
 */
export class WebSocketTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private readonly queue: ClientMessage[] = [];

  constructor(baseUrl: string) {
    this.ws = new WebSocket(this.toWebSocketUrl(baseUrl));
    this.ws.onopen = () => {
      while (this.queue.length > 0) {
        const queued = this.queue.shift();
        if (queued) {
          this.ws?.send(JSON.stringify(queued));
        }
      }
    };
    this.ws.onmessage = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      for (const handler of this.handlers) handler(msg);
    };
    this.ws.onerror = (error) => {
      console.error('[Transport] standalone WebSocket error:', error);
    };
    this.ws.onclose = () => {
      this.ws = null;
    };
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }

    this.queue.push(message);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.queue.length = 0;
  }

  private toWebSocketUrl(baseUrl: string): string {
    const browserGlobals = globalThis as BrowserGlobals;
    const baseHref = browserGlobals.location?.href ?? 'http://127.0.0.1/';
    const url = new URL(baseUrl, baseHref);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    }

    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/ws';
    }

    return url.toString();
  }
}
