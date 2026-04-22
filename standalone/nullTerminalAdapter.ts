import type { ITerminalAdapter, TerminalHandle } from '../core/src/terminalAdapter.js';

export class NullTerminalAdapter implements ITerminalAdapter {
  activeTerminal(): TerminalHandle | undefined {
    return undefined;
  }

  allTerminals(): TerminalHandle[] {
    return [];
  }
}
