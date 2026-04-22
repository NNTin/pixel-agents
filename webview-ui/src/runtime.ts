/**
 * Runtime detection, provider-agnostic
 *
 * Single source of truth for determining whether the webview is running
 * inside an IDE extension (VS Code, Cursor, Windsurf, etc.) or standalone
 * in a browser.
 */

declare function acquireVsCodeApi(): unknown;
type BrowserLocationLike = { search?: string };
type BrowserGlobals = typeof globalThis & { location?: BrowserLocationLike };

type Runtime = 'vscode' | 'browser';
// Future: 'cursor' | 'windsurf' | 'electron' | etc.

const runtime: Runtime = typeof acquireVsCodeApi !== 'undefined' ? 'vscode' : 'browser';

export const isBrowserRuntime = runtime === 'browser';

function resolveStandaloneHostUrl(): string | null {
  const browserGlobals = globalThis as BrowserGlobals;
  if (!isBrowserRuntime || !browserGlobals.location) {
    return null;
  }

  const fromQuery = new URLSearchParams(browserGlobals.location.search ?? '').get('host')?.trim();
  if (fromQuery) {
    return fromQuery;
  }

  const fromEnv = (
    import.meta as ImportMeta & {
      env?: { VITE_PIXEL_AGENTS_HOST_URL?: string };
    }
  ).env?.VITE_PIXEL_AGENTS_HOST_URL?.trim();
  return fromEnv ? fromEnv : null;
}

export const standaloneHostUrl = resolveStandaloneHostUrl();
export const isStandaloneBrowserRuntime = isBrowserRuntime && !!standaloneHostUrl;
export const isMockBrowserRuntime = isBrowserRuntime && !standaloneHostUrl;
