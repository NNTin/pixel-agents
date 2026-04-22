import { afterEach, describe, expect, it, vi } from 'vitest';

interface WindowMessageListener {
  (event: { data: unknown }): void;
}

describe('browser transport', () => {
  const globals = globalThis as typeof globalThis & {
    addEventListener?: (type: 'message', listener: WindowMessageListener) => void;
    removeEventListener?: (type: 'message', listener: WindowMessageListener) => void;
  };
  const originalAddEventListener = globals.addEventListener;
  const originalRemoveEventListener = globals.removeEventListener;

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    globals.addEventListener = originalAddEventListener;
    globals.removeEventListener = originalRemoveEventListener;
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
});
