import type { ServerMessage } from '../../../core/src/messages.js';
import { isBrowserRuntime } from '../runtime.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport } from './types.js';

type MessageEventLike = { data: unknown };
type MessageTargetLike = {
  addEventListener?: (type: 'message', listener: (event: MessageEventLike) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: MessageEventLike) => void) => void;
};

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
  // Future: replace the console send stub with a real browser transport.
  return createBrowserTransport();
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
