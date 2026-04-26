import { afterEach, describe, expect, it, vi } from 'vitest';

interface WindowMessageListener {
  (event: { data: unknown }): void;
}

describe('browser transport', () => {
  const globals = globalThis as typeof globalThis & {
    addEventListener?: (type: 'message', listener: WindowMessageListener) => void;
    removeEventListener?: (type: 'message', listener: WindowMessageListener) => void;
    WebSocket?: typeof WebSocket;
    location?: {
      href: string;
      search: string;
    };
    window?: {
      location: {
        href: string;
        search: string;
      };
    };
  };
  const originalAddEventListener = globals.addEventListener;
  const originalRemoveEventListener = globals.removeEventListener;
  const originalWindow = globals.window;
  const originalWebSocket = globals.WebSocket;
  const originalLocation = globals.location;

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    globals.addEventListener = originalAddEventListener;
    globals.removeEventListener = originalRemoveEventListener;
    globals.window = originalWindow;
    globals.WebSocket = originalWebSocket;
    globals.location = originalLocation;
  });

  it('subscribes to window message events in browser mode', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    globals.addEventListener = addEventListener;
    globals.removeEventListener = removeEventListener;

    const { transport } = await import('../src/transport/index.ts');
    const handler = vi.fn();
    const unsubscribe = transport.onMessage(handler);

    expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    const registeredListener = addEventListener.mock.calls[0]?.[1] as
      | WindowMessageListener
      | undefined;

    if (!registeredListener) {
      throw new Error('Expected a message listener to be registered');
    }

    registeredListener({ data: { type: 'layoutLoaded', layout: null } });
    expect(handler).toHaveBeenCalledWith({ type: 'layoutLoaded', layout: null });

    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith('message', registeredListener);
  });

  it('uses WebSocket transport when a standalone host URL is configured', async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];

      static readonly CONNECTING = 0;
      static readonly OPEN = 1;

      readonly send = vi.fn();
      readonly close = vi.fn();
      readonly url: string;
      readyState = FakeWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: ((error: unknown) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
      }
    }

    globals.location = {
      href: 'http://127.0.0.1:4173/',
      search: '?host=http://127.0.0.1:3210',
    };
    globals.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const { transport } = await import('../src/transport/index.ts');
    const socket = FakeWebSocket.instances[0];

    if (!socket) {
      throw new Error('Expected the standalone transport to create a WebSocket');
    }

    expect(socket.url).toBe('ws://127.0.0.1:3210/ws');

    transport.send({ type: 'webviewReady' });
    expect(socket.send).not.toHaveBeenCalled();
    transport.send({ type: 'requestDiagnostics' });
    expect(socket.send).not.toHaveBeenCalled();

    const handler = vi.fn();
    const unsubscribe = transport.onMessage(handler);

    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'webviewReady' }));
    expect(socket.send).toHaveBeenCalledTimes(1);

    socket.onmessage?.({ data: JSON.stringify({ type: 'layoutLoaded', layout: null }) });
    expect(handler).toHaveBeenCalledWith({ type: 'layoutLoaded', layout: null });

    unsubscribe();
    transport.dispose();
    expect(socket.close).toHaveBeenCalled();
  });
});
