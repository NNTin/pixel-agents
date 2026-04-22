import * as path from 'path';

import { StandalonePixelAgentsHost } from './StandalonePixelAgentsHost.js';

interface CliOptions {
  port: number;
  host: string;
  workspaceDir: string;
  assetsRoot: string;
  repoRoot: string;
}

function parseArgs(argv: string[]): CliOptions {
  const standaloneDir = path.dirname(path.resolve(process.argv[1] ?? 'standalone/host.ts'));
  const repoRoot = path.resolve(standaloneDir, '..');
  const options: CliOptions = {
    port: 3210,
    host: '127.0.0.1',
    workspaceDir: process.cwd(),
    assetsRoot: path.join(repoRoot, 'webview-ui', 'public'),
    repoRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--port' && value) {
      options.port = Number(value);
      index += 1;
    } else if (arg === '--host' && value) {
      options.host = value;
      index += 1;
    } else if (arg === '--workspace-dir' && value) {
      options.workspaceDir = path.resolve(value);
      index += 1;
    } else if (arg === '--assets-root' && value) {
      options.assetsRoot = path.resolve(value);
      index += 1;
    } else if (arg === '--repo-root' && value) {
      options.repoRoot = path.resolve(value);
      index += 1;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const host = new StandalonePixelAgentsHost(parseArgs(process.argv.slice(2)));
  const shutdown = async () => {
    await host.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await host.start();
}

main().catch((error) => {
  console.error('[Pixel Agents] Standalone host failed to start:', error);
  process.exit(1);
});
