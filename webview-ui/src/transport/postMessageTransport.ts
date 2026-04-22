import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

type MessageEventLike = { data: unknown };
type MessageTargetLike = {
  addEventListener?: (type: 'message', listener: (event: MessageEventLike) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: MessageEventLike) => void) => void;
};

/**
 * VS Code webview transport. Uses acquireVsCodeApi().postMessage for sends
 * and window 'message' events for receives.
 */
export class PostMessageTransport implements MessageTransport {
  private readonly vscodeApi: { postMessage(msg: unknown): void };
  private readonly messageTarget: MessageTargetLike;

  constructor() {
    this.vscodeApi = acquireVsCodeApi();
    this.messageTarget = globalThis as typeof globalThis & MessageTargetLike;
  }

  send(message: ClientMessage): void {
    this.vscodeApi.postMessage(message);
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    const listener = (event: MessageEventLike) => handler(event.data as ServerMessage);
    this.messageTarget.addEventListener?.('message', listener);
    return () => this.messageTarget.removeEventListener?.('message', listener);
  }

  dispose(): void {
    // No cleanup needed for postMessage
  }
}
