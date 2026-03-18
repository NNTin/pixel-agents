import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { isBrowserRuntime } from './runtime';

async function main() {
  if (isBrowserRuntime) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();

    // Start d-back runtime: connect to WebSocket and map Discord users to agents
    const { DBackRuntime } = await import('./dback/DBackRuntime.js');
    const dback = new DBackRuntime();
    dback.start();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

main().catch(console.error);
