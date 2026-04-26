import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import { isBrowserRuntime, standaloneHostUrl } from '../runtime.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

type MessageEventLike = { data: unknown };
type MessageTargetLike = {
  addEventListener?: (type: 'message', listener: (event: MessageEventLike) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: MessageEventLike) => void) => void;
};

// Messages a read-only browser viewer is allowed to send.
const VIEWER_ALLOWED_MESSAGES = new Set<ClientMessage['type']>(['webviewReady']);

function wrapReadOnly(inner: MessageTransport): MessageTransport {
  return {
    send: (msg) => {
      if (VIEWER_ALLOWED_MESSAGES.has(msg.type)) {
        inner.send(msg);
      }
    },
    onMessage: inner.onMessage.bind(inner),
    dispose: inner.dispose.bind(inner),
  };
}

function createBrowserTransport(): MessageTransport {
  const messageTarget = globalThis as typeof globalThis & MessageTargetLike;

  return {
    send: (msg) => console.log('[Transport] send:', msg),
    onMessage: (handler) => {
      if (!messageTarget.addEventListener || !messageTarget.removeEventListener) {
        return () => {};
      }

      const listener = (event: MessageEventLike) => handler(event.data as ServerMessage);
      messageTarget.addEventListener('message', listener);
      return () => messageTarget.removeEventListener?.('message', listener);
    },
    dispose: () => {},
  };
}

function createTransport(): MessageTransport {
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  if (standaloneHostUrl) {
    // Browser viewers are read-only; mutating messages are dropped at the transport layer.
    return wrapReadOnly(new WebSocketTransport(standaloneHostUrl));
  }
  // Future: replace the console send stub with a real browser transport.
  return createBrowserTransport();
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
